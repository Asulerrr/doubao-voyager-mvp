# MVP Scope

## Included

- Doubao conversation folders and drag-and-drop organization
- Message quick locator and stars
- Text highlights and a local corpus board
- Conversation export to Markdown, text, and print-friendly PDF
- LaTeX copy and download
- Local browser storage only

## Deferred

- Cloud sync
- Remote services and analytics
- Multi-site adapters
- Automatic account detection
- AI-driven automatic categorization

## Adapter Boundary

The Doubao adapter owns page readiness and conversation-route parsing. Feature modules should consume adapter capabilities instead of embedding site selectors in new code. Existing inherited modules will be moved behind this boundary incrementally.
