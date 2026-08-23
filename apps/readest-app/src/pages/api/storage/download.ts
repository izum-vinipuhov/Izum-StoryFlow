import type { NextApiRequest, NextApiResponse } from 'next';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { getDownloadSignedUrl } from '@/utils/object';
import { validateUserAndToken } from '@/utils/access';
import { ensureSharedLibraryMode, isSharedLibraryEnabled } from '@/services/sharedLibrary';

const DEFAULT_EXPIRES_IN = 1800;
const MIN_EXPIRES_IN = 300;
const MAX_EXPIRES_IN = 21600;

/**
 * Streamed audiobook chapters outlive the default 30-minute signature: a seek
 * into an unbuffered region re-requests the original URL, so the caller may
 * ask for a longer one. Unparseable or out-of-range values fall back / clamp.
 */
function parseExpiresIn(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value)) return DEFAULT_EXPIRES_IN;
  return Math.min(MAX_EXPIRES_IN, Math.max(MIN_EXPIRES_IN, Math.trunc(value)));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user, token } = await validateUserAndToken(req.headers['authorization']);
    if (!user || !token) {
      return res.status(403).json({ error: 'Not authenticated' });
    }
    await ensureSharedLibraryMode();

    if (req.method === 'GET') {
      let { fileKey } = req.query;
      // Also parse fileKey directly from raw URL to handle special characters like & in filenames.
      // because frameworks may incorrectly split parameters when the fileKey value contains
      // encoded & (%26), treating it as a parameter separator.
      if (req.url?.includes('fileKey=') && req.url?.includes('&')) {
        const fileKeyFromUrl = req.url
          .substring(req.url.indexOf('fileKey=') + 8)
          .replace(/\+/g, '%20')
          .replace(/&/g, '%26')
          .replace(/=$/, '');
        fileKey = decodeURIComponent(fileKeyFromUrl);
      }
      if (!fileKey || typeof fileKey !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid fileKey' });
      }

      const downloadUrlsMap = await processFileKeys(
        [fileKey],
        user.id,
        parseExpiresIn(req.query['expiresIn']),
      );
      const downloadUrl = downloadUrlsMap[fileKey];

      if (!downloadUrl) {
        return res.status(404).json({ error: 'File not found' });
      }

      return res.status(200).json({ downloadUrl });
    }

    if (req.method === 'POST') {
      const { fileKeys } = req.body;

      if (!fileKeys || !Array.isArray(fileKeys)) {
        return res.status(400).json({ error: 'Missing or invalid fileKeys array' });
      }

      if (fileKeys.length === 0) {
        return res.status(400).json({ error: 'fileKeys array cannot be empty' });
      }

      if (!fileKeys.every((key) => typeof key === 'string')) {
        return res.status(400).json({ error: 'All fileKeys must be strings' });
      }

      const downloadUrls = await processFileKeys(fileKeys, user.id);

      return res.status(200).json({ downloadUrls });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

type FallbackCandidate = {
  originalKey: string;
  bookHash: string;
  /** The path below `Readest/Books/<hash>/` — `file.epub` or `audiobook/chapter_NNN.m4a`. */
  filename: string;
  fileExtension: string;
};

/**
 * Parse a `${uid}/Readest/Books/<hash>/<file>` key (or the attached-audiobook
 * layout with the extra `audiobook/` segment) into its hash + filename, so a
 * key the caller prefixes with their own id can be resolved against the rows
 * the actual uploader wrote.
 */
const parseFallbackCandidate = (key: string): FallbackCandidate | null => {
  const parts = key.split('/');
  if (!key.includes('Readest/Book') || (parts.length !== 5 && parts.length !== 6)) return null;
  const filename = parts.length === 5 ? parts[4]! : `${parts[4]}/${parts[5]}`;
  return {
    originalKey: key,
    bookHash: parts[3]!,
    filename,
    fileExtension: parts[parts.length - 1]!.split('.').pop() || '',
  };
};

/**
 * Match a candidate against the live files rows of its book: the exact file
 * name first (identical-extensions chapters would otherwise resolve to the
 * wrong one), the extension as a legacy fallback (owner title renames on R2).
 */
const matchCandidateFile = (
  candidate: FallbackCandidate,
  records: Array<{ book_hash: string | null; file_key: string; user_id: string }>,
) =>
  records.find(
    (f) => f.book_hash === candidate.bookHash && f.file_key.endsWith(`/${candidate.filename}`),
  ) ??
  records.find(
    (f) => f.book_hash === candidate.bookHash && f.file_key.endsWith(`.${candidate.fileExtension}`),
  );

async function processFileKeys(
  fileKeys: string[],
  userId: string,
  expiresIn: number = DEFAULT_EXPIRES_IN,
): Promise<Record<string, string | undefined>> {
  const supabase = createSupabaseAdminClient();

  const { data: fileRecords, error: fileError } = await supabase
    .from('files')
    .select('user_id, file_key, book_hash')
    .eq('user_id', userId)
    .in('file_key', fileKeys)
    .is('deleted_at', null);

  if (fileError) {
    console.error('Error querying files:', fileError);
    return Object.fromEntries(fileKeys.map((key) => [key, undefined]));
  }

  const fileRecordMap = new Map((fileRecords || []).map((record) => [record.file_key, record]));

  const missingCandidates = (fileKeys: string[]) =>
    fileKeys
      .filter((key) => !fileRecordMap.has(key))
      .map(parseFallbackCandidate)
      .filter((candidate): candidate is FallbackCandidate => candidate !== null);

  // Owner-scoped fallback: the caller's own files under a slightly different
  // key layout (legacy / R2 title-based keys).
  const fallbackCandidates = missingCandidates(fileKeys);
  if (fallbackCandidates.length > 0) {
    const bookHashes = [...new Set(fallbackCandidates.map((c) => c.bookHash))];

    const { data: fallbackRecords, error: fallbackError } = await supabase
      .from('files')
      .select('user_id, file_key, book_hash')
      .eq('user_id', userId)
      .in('book_hash', bookHashes)
      .is('deleted_at', null);

    if (!fallbackError && fallbackRecords) {
      for (const candidate of fallbackCandidates) {
        const matchedFile = matchCandidateFile(candidate, fallbackRecords);
        if (matchedFile) {
          fileRecordMap.set(candidate.originalKey, matchedFile);
        }
      }
    }
  }

  // Shared-library pass: a peer asks for `${callerId}/Readest/Books/...` while
  // the files live under the owner's id. Gated on the book being marked
  // shared — an unshared hash can never be resolved across users. Signing
  // itself is key-only, so no owner token is needed.
  let sharedBookHashes = new Set<string>();
  if (isSharedLibraryEnabled()) {
    const sharedCandidates = missingCandidates(fileKeys);
    const bookHashes = [...new Set(sharedCandidates.map((c) => c.bookHash))];
    if (bookHashes.length > 0) {
      const { data: sharedBooks } = await supabase
        .from('books')
        .select('book_hash')
        .in('book_hash', bookHashes)
        .eq('shared', true)
        .is('deleted_at', null);
      sharedBookHashes = new Set((sharedBooks ?? []).map((b) => b.book_hash as string));

      if (sharedBookHashes.size > 0) {
        const { data: sharedFiles } = await supabase
          .from('files')
          .select('user_id, file_key, book_hash')
          .in('book_hash', [...sharedBookHashes])
          .is('deleted_at', null);

        for (const candidate of sharedCandidates) {
          if (!sharedBookHashes.has(candidate.bookHash)) continue;
          const matchedFile = matchCandidateFile(candidate, sharedFiles ?? []);
          if (matchedFile) {
            fileRecordMap.set(candidate.originalKey, matchedFile);
          }
        }
      }
    }
  }

  const results = await Promise.allSettled(
    fileKeys.map(async (fileKey) => {
      const fileRecord = fileRecordMap.get(fileKey);

      if (!fileRecord) {
        return { fileKey, downloadUrl: undefined };
      }

      // Another user's file is servable only when its book is shared; the
      // set is empty in private mode, keeping today's behavior exactly.
      if (fileRecord.user_id !== userId && !sharedBookHashes.has(fileRecord.book_hash ?? '')) {
        return { fileKey, downloadUrl: undefined };
      }

      try {
        const downloadUrl = await getDownloadSignedUrl(fileRecord.file_key, expiresIn);
        return { fileKey, downloadUrl };
      } catch (error) {
        console.error('Error creating signed URL for %s:', fileKey, error);
        return { fileKey, downloadUrl: undefined };
      }
    }),
  );

  const downloadUrls: Record<string, string | undefined> = {};

  results.forEach((result, index) => {
    const fileKey = fileKeys[index]!;
    if (result.status === 'fulfilled') {
      downloadUrls[fileKey] = result.value.downloadUrl;
    } else {
      downloadUrls[fileKey] = undefined;
    }
  });

  return downloadUrls;
}
