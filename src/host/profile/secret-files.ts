// Secret-looking files in a workspace, for a warning at launch (the agent can read them: the folder is mapped).
import fs from 'node:fs';
import path from 'node:path';

/** Files that usually hold secrets. The agent CAN read them (the whole folder is mapped); we only warn. */
const SECRET_FILES =
  /^(\.env(\..+)?|\.envrc|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfvars|ovpn)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service[-_]?account.*\.json|id_(rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i;
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

/** Secret-looking files in the workspace root and one folder down (skipping dependency folders). */
export function findSecretFiles(workspace: string): string[] {
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const hit = (name: string): boolean => SECRET_FILES.test(name) && !TEMPLATE.test(name);
  const top = list(workspace);
  const below = top
    .filter((d) => d.isDirectory() && !/^(node_modules|\.git|vendor|target|dist|build|\.venv|venv)$/i.test(d.name))
    .flatMap((d) =>
      list(path.join(workspace, d.name))
        .filter((f) => f.isFile() && hit(f.name))
        .map((f) => d.name + '\\' + f.name),
    );
  return [...top.filter((d) => d.isFile() && hit(d.name)).map((d) => d.name), ...below];
}
