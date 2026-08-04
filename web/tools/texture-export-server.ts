import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Plugin } from 'vite';

const outputDirectory = path.resolve('..', 'dotnet', 'src', 'OperationVanguard.Game', 'Assets', 'Textures');
await mkdir(outputDirectory, { recursive: true });

let exported = 0;
let server: Awaited<ReturnType<typeof createServer>>;

const receiver: Plugin = {
  name: 'operation-vanguard-texture-export',
  configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const match = request.url?.match(/^\/__texture-export\/([a-z]+-(?:albedo|normal)\.png)$/);
      if (request.method === 'POST' && match) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        await writeFile(path.join(outputDirectory, match[1]!), Buffer.concat(chunks));
        exported++;
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === 'POST' && request.url === '/__texture-export-complete') {
        response.statusCode = exported === 32 ? 204 : 409;
        response.end();
        if (exported === 32) {
          setTimeout(() => {
            void server.close().then(() => process.exit(0));
          }, 250);
        }
        return;
      }
      next();
    });
  },
};

server = await createServer({
  configFile: path.resolve('vite.config.ts'),
  plugins: [receiver],
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
});
await server.listen();
console.log('Texture export server ready at http://127.0.0.1:5187/texture-export.html');
