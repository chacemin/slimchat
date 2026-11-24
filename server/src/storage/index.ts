import { ApiError } from '../errors.js';

export function hasFileStorage(env: { FILES?: unknown }): boolean {
  return Boolean(env.FILES);
}

export function getFileStorage<T>(env: { FILES?: T }): T {
  const storage = env.FILES;
  if (!storage) {
    throw new ApiError('本地文件存储不可用', 503, 'storage_unavailable');
  }
  return storage;
}
