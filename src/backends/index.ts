import type { ResolvedConfig, Role } from "../config.js";
import { ROLES } from "../config.js";
import type { Paths } from "../state.js";
import type { Backend } from "./backend.js";
import { headless } from "./headless.js";
import { herdr } from "./herdr.js";

type Env = Record<string, string | undefined>;

export type { Backend } from "./backend.js";

/** The backend selected by `workflow.terminal` for issue `issue` in `p.root`. */
export function backendFor(config: ResolvedConfig, root: string, issue: number, env: Env, p: Paths): Backend {
  if (config.workflow.terminal === "herdr") {
    const agents = Object.fromEntries(ROLES.map((role) => [role, config.roles[role].agent])) as Record<Role, string>;
    return herdr({
      root,
      issue,
      env,
      panesFile: p.panes,
      pidDir: p.pids,
      logs: p.logs,
      agents,
      supervisorPane: config.workflow.supervisor_pane,
    });
  }
  return headless(p.logs, root, env);
}
