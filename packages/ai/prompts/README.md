# Prompts

Versioned prompt files. One folder per prompt, one file per version:

```
prompts/
  missed-call-qualifier/
    v1.md
    v2.md
```

- Never edit a version that has been used in production. Add a new version.
- Every logged conversation records the prompt name and version it used.
- Tenant details (services, hours, tone, knowledge base) are injected from tenant
  config at runtime. Inbound customer text is passed as data, never as instructions.
