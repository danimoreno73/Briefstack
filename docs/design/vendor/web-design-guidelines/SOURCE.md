# Source: Vercel web interface guidelines

Two repositories, because the skill points to a remote file that it tells the agent to fetch at
run time. The brief forbids that, so the remote file is copied here, pinned.

## The skill

- **Repository:** https://github.com/vercel-labs/agent-skills
- **Path:** `skills/web-design-guidelines/SKILL.md` → copied as `SKILL.md`
- **Commit:** `063bee94c3f4df8453406c830b0a7df0f2860278` (committed 2026-08-28)
- **License:** MIT, as stated in the repository README ("## License — MIT"). The repository has no
  LICENSE file at that commit.

## The guidelines it points to

- **Repository:** https://github.com/vercel-labs/web-interface-guidelines
- **Files:** `command.md` (the rules the skill fetches, from
  `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`) and
  `AGENTS.md` (the same rules in MUST/SHOULD/NEVER form, with a few more)
- **Commit:** `434b7f91364665f2f733b310ec54809bf8f37937` (committed 2026-10-05)
- **License:** MIT, Copyright (c) 2025 Vercel Labs (see `LICENSE` in this folder)

**Copied on:** 2026-10-20. All files unchanged.

## How it is used

`command.md` and `AGENTS.md` are the audit checklist for `docs/design/audit.md`. The skill's
instruction to "fetch fresh guidelines before each review" is not followed: the pinned copy here is
the checklist. Rules about frameworks briefstack does not use (hydration, `next/font`, React
DevTools, image CDNs) are recorded as not applicable rather than as findings.
