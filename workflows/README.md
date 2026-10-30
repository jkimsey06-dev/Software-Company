# Workflows

n8n workflow exports (JSON), one folder per workflow:

```
workflows/
  missed-call-text-back/
    workflow.json
    README.md   # trigger, inputs, outputs, failure handling
```

- Export with credentials stripped. No secrets in these files.
- Each README says what happens when Twilio, Claude or the calendar is down,
  and which idempotency key prevents a double send.
