# Image review integration — 15 September 2026

OpenAI Chat Completions accepts image content parts with base64 data URLs and an image-detail setting. This lets the server submit private image bytes without exposing a public storage URL. The current completion limit field is `max_completion_tokens`; the adapter uses it for OpenAI and keeps the compatible-provider field for other endpoints. [API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

Vision inputs consume tokens. Models can misread small and non-Latin text and make inaccurate visual descriptions. Higher detail helps but is not proof of correctness. [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)

OriginPost sends the composed card and selected original-logo crop at high detail, compares transcribed text with saved copy, and retains version-bound findings. A generated color sample checks image-input support before enabling a configured model. This is separate from direct image generation in the interactive Codex app and does not establish a headless desktop-image API. No live vision accuracy claim is made from substituted-provider tests.
