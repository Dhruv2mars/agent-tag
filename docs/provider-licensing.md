# Provider access and licensing

Agent Tag does not grant rights to use Codex, Claude, or another provider. A provider appearing as ready and authenticated in T3 is a technical signal, not proof that the account may be shared with a Slack workspace or used for a particular business purpose.

Before deployment, the operator must document and approve each configured provider's:

- organization or account owner;
- authentication method;
- applicable plan or commercial agreement;
- allowed users and use case; and
- review date.

Do not put a personal account, browser session, CLI session, API key, or subscription credential behind Agent Tag for other Slack users. Use organization-controlled access that the provider permits for the intended users and workload, such as a business/API organization, assigned seats, or an approved gateway. Keep credentials in private operator-owned files; never distribute them through Slack, configuration files committed to Git, prompts, logs, screenshots, or evidence.

The current Codex and Claude sessions on the development host are used only to validate the integration. Their presence does not establish redistribution, multi-user, or commercial-use permission. A deployment remains blocked until its operator confirms the applicable provider terms and account authority. Obtain legal or procurement review when the organization's policy requires it.

## Provider references

- OpenAI states that an account is for the individual who created it and that another person should use their own account: [Account Sharing Policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy).
- OpenAI business and API use is governed by the [Services Agreement](https://cdn.openai.com/osa/openai-services-agreement.pdf), together with the applicable [Service Terms](https://openai.com/policies/service-terms/) and policies.
- Anthropic describes API access as organization-based commercial access: [How can I access the Anthropic API?](https://support.anthropic.com/en/articles/8114521-how-can-i-access-the-anthropic-api).
- Anthropic distinguishes commercial API and Claude Code use through an organization API key from Claude Pro and Max consumer plans: [Zero data retention product scope](https://privacy.anthropic.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to).
- Anthropic documents enterprise gateways for centralized authentication, usage tracking, budgets, and audit: [Claude Code LLM gateway](https://docs.anthropic.com/en/docs/claude-code/llm-gateway).

These links are operational references, not legal advice. Terms can change; review the current provider documents before production use.
