#[cfg(any(target_os = "macos", test))]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SystemProxy {
    pub url: String,
    pub no_proxy: String,
}

pub(crate) fn has_proxy_env() -> bool {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// An inherited proxy keeps its existing behavior; only an unset environment
/// falls back to macOS. Never rewrite the host process's environment.
pub(crate) fn fallback() -> Option<SystemProxy> {
    if has_proxy_env() {
        None
    } else {
        read_cached()
    }
}

#[cfg(target_os = "macos")]
fn read_cached() -> Option<SystemProxy> {
    type Cache = Option<(Instant, Option<SystemProxy>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().ok()?;
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return value.clone();
        }
    }
    let value = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| parse_scutil_proxy(&text));
    *cache = Some((Instant::now(), value.clone()));
    value
}

#[cfg(not(target_os = "macos"))]
fn read_cached() -> Option<SystemProxy> {
    None
}

/// The updater's native HTTP client retains inherited proxy handling when
/// this returns None. Run scutil off the command's async executor thread.
#[tauri::command]
pub async fn system_proxy_url() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| fallback().map(|proxy| proxy.url))
        .await
        .unwrap_or(None)
}

#[cfg(any(target_os = "macos", test))]
fn parse_scutil_proxy(text: &str) -> Option<SystemProxy> {
    let mut values = HashMap::new();
    let mut exceptions = Vec::new();
    let mut depth: usize = 0;
    let mut exceptions_depth = None;
    for line in text.lines().map(str::trim) {
        if line == "}" {
            if exceptions_depth == Some(depth) {
                exceptions_depth = None;
            }
            depth = depth.saturating_sub(1);
            continue;
        }
        if line.ends_with("<dictionary> {") || line.ends_with("<array> {") {
            if depth == 1 && line == "ExceptionsList : <array> {" {
                exceptions_depth = Some(depth + 1);
            }
            depth += 1;
            continue;
        }
        let Some((key, value)) = line.split_once(" : ") else {
            continue;
        };
        if depth == 1 {
            values.insert(key, value.trim());
        } else if exceptions_depth == Some(depth) && key.parse::<usize>().is_ok() {
            exceptions.push(value.trim());
        }
    }
    let url = ["HTTPS", "HTTP"].into_iter().find_map(|kind| {
        if values.get(format!("{kind}Enable").as_str()) != Some(&"1") {
            return None;
        }
        let host = *values.get(format!("{kind}Proxy").as_str())?;
        let port = values
            .get(format!("{kind}Port").as_str())?
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)?;
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        crate::harness::validate_agent_proxy_url(&format!("http://{host}:{port}")).ok()
    })?;
    let mut bypass = vec!["localhost", "127.0.0.1", "::1"];
    for entry in exceptions {
        if entry.is_empty() || entry == "<local>" {
            continue;
        }
        let entry = if entry.starts_with("*.") {
            &entry[1..]
        } else {
            entry
        };
        if !bypass.iter().any(|seen| seen.eq_ignore_ascii_case(entry)) {
            bypass.push(entry);
        }
    }
    Some(SystemProxy {
        url,
        no_proxy: bypass.join(","),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCUTIL: &str = r#"<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : 172.29.0.0/16
    5 : localhost
    6 : *.local
    7 : *.crashlytics.com
    8 : <local>
    9 : pjlab.org.cn
    10 : *.pjlab.org.cn
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}"#;

    #[test]
    fn system_proxy_parses_scutil_and_converts_exceptions() {
        let proxy = parse_scutil_proxy(SCUTIL).unwrap();
        assert_eq!(proxy.url, "http://127.0.0.1:7897");
        assert_eq!(proxy.no_proxy, "localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,172.29.0.0/16,.local,.crashlytics.com,pjlab.org.cn,.pjlab.org.cn");
    }

    #[test]
    fn system_proxy_prefers_enabled_https_then_http() {
        let text = SCUTIL.replace("HTTPSPort : 7897", "HTTPSPort : 8080");
        assert_eq!(
            parse_scutil_proxy(&text).unwrap().url,
            "http://127.0.0.1:8080"
        );
        let text = text.replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert_eq!(
            parse_scutil_proxy(&text).unwrap().url,
            "http://127.0.0.1:7897"
        );
        let text = text.replace("HTTPEnable : 1", "HTTPEnable : 0");
        assert_eq!(parse_scutil_proxy(&text), None);
    }

    #[test]
    fn system_proxy_ignores_socks_pac_and_scoped_settings() {
        assert_eq!(
            parse_scutil_proxy(
                r#"<dictionary> {
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 7897
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : https://example.com/proxy.pac
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : scoped.example
      HTTPPort : 8080
    }
  }
}"#
            ),
            None
        );
    }

    #[test]
    fn system_proxy_rejects_credentials_and_non_origins() {
        for host in [
            "user:pass@proxy.example",
            "proxy.example/path",
            "proxy.example?query",
        ] {
            assert_eq!(
                parse_scutil_proxy(&format!(
                    "<dictionary> {{\n HTTPEnable : 1\n HTTPProxy : {host}\n HTTPPort : 8080\n}}"
                )),
                None
            );
        }
    }
}
