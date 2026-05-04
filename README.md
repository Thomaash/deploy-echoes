# @tomina/deploy-echoes

Small CLI for static-site deployment on simple CDN-backed hosts such as GitHub Pages.

`deploy-echoes` is for sites where recently removed files still need to stay deployable for a while, but your host/CDN cannot simply delete content older than a chosen retention age. It rebuilds a publishable output from the current build plus archived previous deploys so old paths can keep resolving until they age out of the archive window.

## Quick start

```sh
npm install --save-dev @tomina/deploy-echoes
```

```sh
npx deploy-echoes https://username.github.io/your-site/deploy-echoes/
```

- The CLI argument is the public URL of the published archive directory, not the site root.
- The archive directory must be published with the site output.
- By default that directory is `deploy-echoes`, so a site rooted at `https://username.github.io/your-site/` would publish archives at `https://username.github.io/your-site/deploy-echoes/`.
- Run `deploy-echoes --help` for detailed flags.

## What it is not for

- Atomic deploys
- Rollback management
- Traffic shifting
- Independently versioned sites under separate URLs

## License

ISC - see [LICENSE](./LICENSE).
