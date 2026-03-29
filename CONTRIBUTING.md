# Contributors

Thank you to everyone who contributes to Viewstor!

## Maintainers

- **Aleksandr Tseluyko** — [@Siyet](https://github.com/Siyet)

## How to Contribute

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests where applicable
4. Run linting and tests:
   ```bash
   npm run lint
   npm test
   npm run test:e2e   # if Docker is available
   ```
5. Commit with a clear message describing the change
6. Push and open a Pull Request

### What We're Looking For

- New database driver implementations (MySQL, MongoDB, SQLite, ...)
- Query editor improvements (syntax highlighting, autocomplete)
- Result grid enhancements (sorting, filtering, pagination)
- Connection form UI (webview-based instead of input boxes)
- Bug fixes and performance improvements
- Documentation improvements

### Guidelines

- Follow the existing code style (enforced by ESLint)
- Add unit tests for pure functions and e2e tests for driver changes
- Keep PRs focused — one feature or fix per PR
- Use English for code, comments, and commit messages
