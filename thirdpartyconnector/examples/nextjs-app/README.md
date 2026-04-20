# Next.js Partner App Example

## Run

```bash
cd thirdpartyconnector/examples/nextjs-app
npm install
cp ../../docs/.env.example .env.local
npm run dev
```

Open `http://localhost:3401` and click `Continue with HiveMind`.

## Routes

- `POST /api/hivemind/start`: creates PKCE + state and redirects to HiveMind `/oauth/authorize`
- `GET /api/hivemind/callback`: validates state and exchanges code for tokens
- `GET /api/hivemind/status`: checks connection and refreshes token on 401
- `POST /api/hivemind/disconnect`: revokes token and clears stored connection
