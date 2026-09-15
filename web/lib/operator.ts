/**
 * Who runs the site, for the privacy policy and the terms.
 *
 * GDPR requires the privacy policy to name the controller and give a way to
 * reach them (Art. 13(1)(a)). Neither exists yet — the project has no name and
 * no domain (CLAUDE.md §19.1) — so they come from the environment, like
 * PUBLIC_BASE_URL, and choosing them is a config change.
 *
 * Unset values render as a visible placeholder rather than as nothing: a policy
 * that silently names nobody reads as complete when it is not.
 */

export interface Operator {
  name: string;
  email: string;
  configured: boolean;
}

export function operator(env: Record<string, string | undefined> = process.env): Operator {
  const name = (env.OPERATOR_NAME ?? '').trim();
  const email = (env.CONTACT_EMAIL ?? '').trim();
  return {
    name: name || '[OPERATOR_NAME not set]',
    email: email || '[CONTACT_EMAIL not set]',
    configured: Boolean(name && email),
  };
}
