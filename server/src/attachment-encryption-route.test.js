import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { registerUploadRoutes } from './api/upload.js';
import { encryptAttachment } from './encryption.js';

const keyring = JSON.stringify({
  activeKeyId: 'v1',
  keys: {
    v1: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64')
  }
});

const sessions = {
  async get() {
    return JSON.stringify({ userId: 42, isAdmin: false, sessionVersion: 0 });
  }
};

function fileDb({ accessible, metadata = true }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('AS public_reference')) {
                return { results: [{ public_reference: 0 }] };
              }
              if (sql.includes('FROM users u')) {
                return { results: [{ id: 42, is_disabled: 0, session_version: 0, is_super_admin: 0 }] };
              }
              if (sql.includes('SELECT filename, content_type, size')) {
                return metadata
                  ? { results: [{ filename: '报告.bin', content_type: 'application/octet-stream', size: 4 }] }
                  : { results: [] };
              }
              return { results: accessible ? [{ found: 1 }] : [] };
            }
          };
        }
      };
    }
  };
}

test('attachment upload reports when local storage is unavailable', async () => {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('session', { userId: 42 });
    return next();
  });
  registerUploadRoutes(app);

  const formData = new FormData();
  formData.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
  const response = await app.request(
    'https://edgechat.test/api/upload',
    {
      method: 'POST',
      body: formData
    },
    {}
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: '本地附件存储不可用'
  });
});

test('authorized attachment download decrypts bytes and disables shared caching', async () => {
  const objectKey = '42/example.bin';
  const plaintext = Uint8Array.from([1, 2, 3, 4]);
  const ciphertext = await encryptAttachment(keyring, plaintext, objectKey);
  const object = {
    lastModified: Date.parse('2026-08-10T00:00:00Z'),
    async exists() { return true; },
    async arrayBuffer() {
      return ciphertext.buffer;
    }
  };
  let storageRead = false;
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    `https://edgechat.test/files/${objectKey}?token=valid-session`,
    {},
    {
      DB: fileDb({ accessible: true }),
      SESSIONS: sessions,
      FILES: {
        get() {
          storageRead = true;
          return object;
        }
      },
      ENCRYPTION_KEYRING: keyring
    }
  );

  assert.equal(response.status, 200);
  assert.equal(storageRead, true);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), plaintext);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /%E6%8A%A5%E5%91%8A\.bin/);
});

test('unauthorized attachment download is rejected before reading storage', async () => {
  let storageRead = false;
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    'https://edgechat.test/files/42/private.bin',
    {},
    {
      DB: fileDb({ accessible: false }),
      FILES: {
        get() {
          storageRead = true;
          return null;
        }
      },
      ENCRYPTION_KEYRING: keyring
    }
  );

  assert.equal(response.status, 403);
  assert.equal(storageRead, false);
});

test('authorized attachment download reports when local storage is unavailable', async () => {
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    'https://edgechat.test/files/42/private.bin?token=valid-session',
    {},
    { DB: fileDb({ accessible: true }), SESSIONS: sessions }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: '本地附件存储不可用'
  });
});

test('attachment referenced by an accessible message downloads without an uploaded_files row', async () => {
  const objectKey = '42/9-example.jpg';
  const plaintext = Uint8Array.from([5, 6, 7]);
  const ciphertext = await encryptAttachment(keyring, plaintext, objectKey);
  const app = new Hono();
  registerUploadRoutes(app);

  const response = await app.request(
    `https://edgechat.test/files/${encodeURIComponent(objectKey)}?token=valid-session`,
    {},
    {
      DB: fileDb({ accessible: true, metadata: false }),
      SESSIONS: sessions,
      FILES: {
        get() {
          return {
            lastModified: Date.now(),
            async exists() { return true; },
            async arrayBuffer() {
              return ciphertext.buffer;
            }
          };
        }
      },
      ENCRYPTION_KEYRING: keyring
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), plaintext);
  assert.match(response.headers.get('content-disposition'), /9-example\.jpg/);
});
