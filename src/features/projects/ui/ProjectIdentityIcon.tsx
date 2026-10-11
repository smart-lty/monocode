import { useMemo, useState } from "react";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";

export type ProjectAppearance = {
  colors: Record<string, number>;
  customColors: Record<string, string>;
  labels: Record<string, string>;
  mascots: Record<string, string>;
  logos: Record<string, string>;
};

/** Project appearance as the project rail resolves it, read once per list. */
export function useProjectAppearance(): ProjectAppearance {
  const [stored] = useState(() => ({
    colors: loadTabGroupColors(),
    customColors: loadTabGroupCustomColors(),
    labels: loadTabGroupLabels(),
    mascots: loadTabGroupMascots(),
  }));
  const logos = useTabGroupLogos();
  return useMemo(() => ({ ...stored, logos }), [stored, logos]);
}

export function projectDisplayName(cwd: string, appearance: ProjectAppearance) {
  return resolveTabGroupLabel(
    projectKey(cwd),
    appearance.labels,
    projectName(cwd),
  );
}

/** The rail's logo when set, otherwise its colored mascot. */
export function ProjectIdentityIcon({
  cwd,
  appearance,
  className = "size-4",
}: {
  cwd: string;
  appearance: ProjectAppearance;
  className?: string;
}) {
  const key = projectKey(cwd);
  const logo = resolveTabGroupLogo(key, appearance.logos);
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center ${className}`}
    >
      {logo ? (
        <ProjectLogoIcon
          path={logo}
          className={`${className} rounded-sm`}
          imageClassName={className}
        />
      ) : (
        <ProjectMascot
          project={projectName(cwd)}
          color={resolveTabGroupColor(
            key,
            appearance.colors,
            appearance.customColors,
            projectName(cwd),
          )}
          name={resolveTabGroupMascot(key, appearance.mascots)}
          className="size-3"
        />
      )}
    </span>
  );
}
