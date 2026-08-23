import type { NextApiRequest, NextApiResponse } from 'next';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';
import { deleteObject } from '@/utils/object';
import { isSharedLibraryEnabled } from '@/services/sharedLibrary';

/**
 * When the owner's last file for a book goes away, the shared flag must go
 * with it — otherwise every peer keeps seeing a book whose files are gone.
 * Only the owner can reach this code (all delete queries are owner-scoped),
 * so a non-owner removing the book from their library never touches it.
 */
const clearSharedWhenFilesGone = async (
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  bookHash: string,
): Promise<void> => {
  if (!isSharedLibraryEnabled()) return;
  const { data } = await supabase
    .from('files')
    .select('id')
    .eq('user_id', userId)
    .eq('book_hash', bookHash)
    .is('deleted_at', null)
    .limit(1);
  if (!data || data.length === 0) {
    await supabase
      .from('books')
      .update({ shared: false })
      .eq('user_id', userId)
      .eq('book_hash', bookHash);
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user, token } = await validateUserAndToken(req.headers['authorization']);
    if (!user || !token) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    const { fileKey, bookHash } = req.query;

    // Delete-by-book-hash: removes every object registered for a book. Used
    // for server-downloaded Yandex books, which a peer may delete without
    // ever having downloaded the files locally (the local manifest that
    // normally enumerates the cloud objects does not exist there).
    if (bookHash && typeof bookHash === 'string') {
      const supabase = createSupabaseAdminClient();
      const { data: fileRecords, error: listError } = await supabase
        .from('files')
        .select('id, file_key')
        .eq('user_id', user.id)
        .eq('book_hash', bookHash)
        .is('deleted_at', null);

      if (listError) {
        return res.status(500).json({ error: listError.message });
      }
      const records = (fileRecords ?? []) as Array<{ id: string; file_key: string }>;
      if (records.length === 0) {
        return res.status(404).json({ error: 'No files found for this book' });
      }

      let deletedCount = 0;
      for (const record of records) {
        try {
          await deleteObject(record.file_key);
        } catch (error) {
          // A missing object is fine — the row still needs to go.
          console.warn(`Failed to delete object ${record.file_key}:`, error);
        }
        const { error: deleteError } = await supabase.from('files').delete().eq('id', record.id);
        if (deleteError) {
          console.error('Error deleting file record:', deleteError);
          continue;
        }
        deletedCount++;
      }
      await clearSharedWhenFilesGone(supabase, user.id, bookHash);
      return res.status(200).json({ message: 'Book files deleted', deletedCount });
    }

    if (!fileKey || typeof fileKey !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid fileKey' });
    }

    const supabase = createSupabaseAdminClient();
    const { data: fileRecord, error: fileError } = await supabase
      .from('files')
      .select('user_id, id, book_hash')
      .eq('user_id', user.id)
      .eq('file_key', fileKey)
      .limit(1)
      .single();

    if (fileError || !fileRecord) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (fileRecord.user_id !== user.id) {
      return res.status(403).json({ error: 'Unauthorized access to the file' });
    }

    try {
      await deleteObject(fileKey);
      const { error: deleteError } = await supabase.from('files').delete().eq('id', fileRecord.id);

      if (deleteError) {
        console.error('Error updating file record:', deleteError);
        return res.status(500).json({ error: 'Could not update file record' });
      }

      if (typeof fileRecord.book_hash === 'string') {
        await clearSharedWhenFilesGone(supabase, user.id, fileRecord.book_hash);
      }

      res.status(200).json({ message: 'File deleted successfully' });
    } catch (error) {
      console.error('Error deleting file from S3:', error);
      res.status(500).json({ error: 'Could not delete file from storage' });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
