---
description: "GLM Harness product composition, native model routing, desktop overlay, and brand contribution owners."
kind: "package-group"
---

# GLM Harness packages

English | [中文](README.zh.md)

## Summary

Compose GH through the existing DSH plugin runtime. These product packages select public capabilities and own GLM-specific behavior. Model and account implementations are GH-owned; shared conversation infrastructure belongs to the [conversation subsystem](../../docs/subsystems/conversation.md).

## Packages

| Package | Purpose |
| --- | --- |
| [base](base/README.md) | Shared GH composition and upstream-business closure |
| [model-glm](model-glm/README.md) | Native GLM requests, streams, reasoning, and usage |
| [brand](brand/README.md) | Browser identity and theme contributions |
| [desktop](desktop/README.md) | Reserved desktop profile overlay |

## Further Exploration

- [Architecture](../../docs/architecture.md) — plugin and public service boundaries.
- [Delivery status](../../docs/glm/delivery-status.json) — implementation evidence and remaining work.
