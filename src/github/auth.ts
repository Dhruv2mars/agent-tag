// GitHub credentials held by Agent Tag. Only fine-grained personal access tokens read from a 0600 secret
// file are supported here; GitHub App installation tokens are a follow-up (PR-M sub-PR M3).
import type { GitHubConfig } from "../config.ts";
import { readSecretFile, type SecretString } from "../security/secret-file.ts";

export interface GitHubCredentials {
  /** A token for `repo` (`owner/name`). PAT files are re-read on every call, so rotation needs no restart. */
  token(repo: string): Promise<SecretString>;
  /** Safe to log: names the credential type and file, never the value. */
  describe(): string;
}

export class GitHubCredentialError extends Error {
  readonly code = "github.credential";

  constructor(message: string) {
    super(message);
    this.name = "GitHubCredentialError";
  }
}

/** HTTP header values and git askpass answers must be one printable token with no whitespace. */
export function assertUsableToken(token: SecretString): SecretString {
  if (!/^[\x21-\x7e]+$/.test(token.exposeToBoundary())) {
    throw new GitHubCredentialError("GitHub token contains whitespace or non-printable characters");
  }
  return token;
}

export function tokenFileCredentials(
  tokenFile: string,
  readSecret: (path: string) => Promise<SecretString> = readSecretFile,
): GitHubCredentials {
  return {
    async token() {
      let secret: SecretString;
      try {
        secret = await readSecret(tokenFile);
      } catch (error) {
        // readSecretFile messages name the path and the permission problem, never the content.
        const reason = error instanceof Error ? error.message : "unreadable";
        throw new GitHubCredentialError(`GitHub token file could not be read: ${reason}`);
      }
      return assertUsableToken(secret);
    },
    describe: () => `personal access token from ${tokenFile}`,
  };
}

export function githubCredentialsFromConfig(
  github: GitHubConfig,
  readSecret?: (path: string) => Promise<SecretString>,
): GitHubCredentials {
  switch (github.auth.type) {
    case "token":
      return tokenFileCredentials(github.auth.tokenFile, readSecret);
  }
}
