# decidekit documentation

Start with the [project README](../README.md) for installation and a quick start with Claude or Ollama.

- [API reference](api.md): `decide()`, `defineQuestions`, result types (`ok`/`error`, `confidence`, `scores`), errors, `anthropicProvider`, `ollamaProvider`, the `Provider` interface, CLI exit codes and the smoke scripts.
- [Question set format](question-set-format.md): how to write question sets in YAML, every field, and the errors you can get.
- [Labelled examples format](labelled-examples-format.md): how to write `<set>.examples.yaml` files and measure accuracy with `decidekit test`.
- [Examples](../examples/README.md): five ready-made question sets with sample inputs and their expected answers.
- [Contributing](../CONTRIBUTING.md): development setup, tests, and how to add a provider.

`confidence` and choice `scores` are the model's own estimates and are uncalibrated in this first phase.
