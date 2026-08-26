import { NextRequest, NextResponse } from 'next/server';
import { YANDEX_TOKEN_ERROR } from '@/services/yandex/utils';

/**
 * Catalogue search proxy for web builds: the browser cannot reach the
 * GraphQL gateway directly (CORS), so the client POSTs here instead of
 * calling api-gateway itself. The target host is fixed (no SSRF surface);
 * the token arrives in the body and is never logged.
 *
 * The operation document is byte-identical to the one registered in the
 * gateway's whitelist — any modified query is rejected with "Whitelist:
 * query not found". Query taken from stepan163s/yandex-book-api (MIT).
 */
const YANDEX_GRAPHQL_API = 'https://api-gateway.bookmate.yandex.net/graphql';

const YANDEX_SEARCH_QUERY = `

query Search($query: SearchParamsInput!) {
    search(query: $query) {
        page {
            __typename
            ...searchSnippetAudioBookFragment
            ...searchSnippetTextBookFragment
            ...searchSnippetComicBookFragment
            ...searchSnippetTextSerialFragment
            ...bookshelfFragment
            ...personFragment
            ...publisherFragment
            ...seriesFragment
            ...topicFragment
            ...userFragment
        }
        cursor
        rankedFilter { filterType }
        misspell { correctedText correctionType }
    }
}
fragment coverFragment on Cover { url ratio backgroundColorHex }
fragment personFragment on Person { avatar { __typename ...coverFragment } name uuid worksCount roles }
fragment bookFragment on Book { annotation name cover { __typename ...coverFragment } uuid authors { __typename ...personFragment } ageRestriction editorAnnotation }
fragment publisherFragment on Publisher { avatar { __typename ...coverFragment } name uuid worksCount }
fragment publisherBookFragment on Book { publisher { __typename ...publisherFragment } }
fragment translatorsBookFragment on Book { translators { __typename ...personFragment } }
fragment topicsBookFragment on Book { topics { name totalBook uuid } }
fragment subscriptionLevelsFragment on Book { subscriptionLevels }
fragment snippetBookFragment on Book { __typename ...bookFragment ...publisherBookFragment ...translatorsBookFragment ...topicsBookFragment ...subscriptionLevelsFragment }
fragment bookTagFragment on Tag { name value }
fragment narratorsAudioBookFragment on AudioBook { narrators { __typename ...personFragment } }
fragment progressFragment on Progress { finished inLibrary progress isPublic }
fragment progressAudioBookFragment on AudioBook { progress { __typename ...progressFragment } }
fragment listenersCountAudioBookFragment on AudioBook { listenersCount }
fragment searchSnippetAudioBookFragment on AudioBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...narratorsAudioBookFragment ...progressAudioBookFragment ...listenersCountAudioBookFragment }
fragment progressTextBookFragment on TextBook { progress { __typename ...progressFragment } }
fragment readersCountTextBookFragment on TextBook { readersCount }
fragment searchSnippetTextBookFragment on TextBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...progressTextBookFragment ...readersCountTextBookFragment }
fragment progressComicBookFragment on ComicBook { progress { __typename ...progressFragment } }
fragment readersCountComicBookFragment on ComicBook { readersCount }
fragment searchSnippetComicBookFragment on ComicBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...progressComicBookFragment ...readersCountComicBookFragment }
fragment textSerialFragment on TextSerial { book { __typename ...bookFragment } }
fragment episodesTextSerialFragment on TextSerial { episodes { total } }
fragment readersCountTextSerialFragment on TextSerial { readersCount }
fragment searchSnippetTextSerialFragment on TextSerial { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...textSerialFragment ...episodesTextSerialFragment ...readersCountTextSerialFragment }
fragment userFragment on User { avatar { __typename ...coverFragment } name uuid followersCount login }
fragment bookshelfFragment on Bookshelf { cover { __typename ...coverFragment } name uuid user { __typename ...userFragment } posts { total } followersCount description }
fragment seriesFragment on Series { authors { __typename ...personFragment } cover { __typename ...coverFragment } name uuid items { followersCount total } }
fragment topicFragment on Topic { name slug totalBook uuid parent { name slug totalBook uuid } }

`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  let body: { query?: unknown; token?: unknown };
  try {
    body = (await request.json()) as { query?: unknown; token?: unknown };
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!query) {
    return NextResponse.json({ error: 'Missing query' }, { status: 400, headers: CORS_HEADERS });
  }
  if (!token) {
    return NextResponse.json({ error: YANDEX_TOKEN_ERROR }, { status: 401, headers: CORS_HEADERS });
  }

  let response: Response;
  try {
    response = await fetch(YANDEX_GRAPHQL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Auth-Token': token,
        Accept: 'multipart/mixed; deferSpec=20220824, application/json',
      },
      body: JSON.stringify({
        operationName: 'Search',
        variables: { query: { cursor: '', noMisspell: false, query, types: [] } },
        query: YANDEX_SEARCH_QUERY,
      }),
    });
  } catch {
    return NextResponse.json(
      { error: 'Yandex search unavailable' },
      { status: 502, headers: CORS_HEADERS },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return NextResponse.json({ error: YANDEX_TOKEN_ERROR }, { status: 401, headers: CORS_HEADERS });
  }
  if (!response.ok) {
    return NextResponse.json(
      { error: `Yandex search failed (${response.status})` },
      { status: 502, headers: CORS_HEADERS },
    );
  }
  const data = (await response.json()) as { data?: { search?: { page?: unknown } } };
  const page = data?.data?.search?.page;
  const results = Array.isArray(page)
    ? page.flatMap((item) => {
        const typename = (item as { __typename?: string } | null)?.__typename;
        const book = (item as { book?: { uuid?: string; name?: string } } | null)?.book;
        const typeMap: Record<string, string> = {
          TextBook: 'book',
          TextSerial: 'serial',
          AudioBook: 'audiobook',
          ComicBook: 'comicbook',
        };
        const type = typename ? typeMap[typename] : undefined;
        if (!type || !book?.uuid) return [];
        return [{ type, uuid: book.uuid, name: book.name ?? '' }];
      })
    : [];
  return NextResponse.json(
    { results },
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
  );
}
