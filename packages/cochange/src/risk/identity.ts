import { execFile } from "node:child_process";
import { mapThroughMailmap } from "@code-health/history/identity-mapping";

function configValue(root: string, key: string): Promise<string> {
  return new Promise((resolve) => {
    // The user's own configuration is what names them, so unlike the analysis reads this one is not isolated from it.
    execFile("git", ["config", "--get", key], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      resolve(error ? "" : stdout.trim());
    });
  });
}

/**
 * The git identity of whoever runs the command, mapped through the mailmap as the authors of a change
 * are: `GIT_AUTHOR_EMAIL` if set, else `user.email`. Null when none is configured. This is a default for
 * deciding whose placement to compute, not an access control, since anyone can set a git identity.
 */
export async function invokingUser(root: string, localMailmap: string | undefined): Promise<{ name: string; email: string } | null> {
  const email = process.env.GIT_AUTHOR_EMAIL?.trim() || (await configValue(root, "user.email"));
  if (email === "") return null;
  const name = process.env.GIT_AUTHOR_NAME?.trim() || (await configValue(root, "user.name"));
  const mapped = (await mapThroughMailmap(root, [{ name, email }], localMailmap)).get(`${name} <${email}>`);
  return mapped ?? { name, email };
}
