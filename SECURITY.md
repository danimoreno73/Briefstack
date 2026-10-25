# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Go to the repository's **Security** tab and choose **Report a
   vulnerability** (GitHub's private vulnerability reporting).
2. Describe what is affected, how to reproduce it, and what an attacker
   could do with it. Leave out any real key, token or personal data.

You should get a first answer within a week. Once a fix is ready, it is
released and the advisory is published, crediting you unless you prefer
otherwise.

A problem in Claude Code itself, or in the Agent SDK, should go to
Anthropic instead: see [Claude Code's security
page](https://code.claude.com/docs/en/legal-and-compliance#security-vulnerability-reporting).

## What counts

briefstack runs on your own machine and drives your own Claude Code. Its
security model is described in the README ("Security model, in short").
Examples of what to report:

- a way for another web page, another local user or another process to use
  the web app's API without the launch token;
- a way for a creation, the chat or an improvement to write outside the
  folders it is allowed, or to bypass the permission prompts;
- a skill from the library that briefstack executes, or that reaches a
  project without being approved;
- a credential or personal data written to a file, a log or the web page.

## Supported versions

Only the latest release on the default branch gets fixes.
