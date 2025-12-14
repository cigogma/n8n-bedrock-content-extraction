# Build and run the n8n image with your custom node

Build the image from the repository root:

```bash
docker build -t n8n-custom-node .
```

Run n8n (maps default port 5678 and persists `~/.n8n`):

```bash
docker run --rm -it \
  -p 5678:5678 \
  n8n-custom-node
```

Notes:
- If your project outputs compiled JS to a different folder than `build/nodes`, update `Dockerfile` accordingly.
- If the build requires additional devDependencies, ensure your `package.json` has a `build` script that produces JS files under `build/nodes`.
