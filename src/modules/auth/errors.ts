/**
 * Deliberately generic — never reveals whether the email exists, whether
 * the account is inactive, or that the password was wrong (PROMPT_SPRINT_1:
 * "Generic login error message").
 */
export class AuthenticationError extends Error {
  readonly code = "AUTHENTICATION_FAILED" as const;

  constructor() {
    super("Invalid email or password.");
    this.name = "AuthenticationError";
  }
}
