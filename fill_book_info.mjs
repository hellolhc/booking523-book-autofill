const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;

const TITLE_PROPERTY = "읽고 싶은 책";
const AUTHOR_PROPERTY = "저자";
const PUBLISHER_PROPERTY = "출판사";

if (!NOTION_TOKEN || !NOTION_DATABASE_ID || !KAKAO_REST_API_KEY) {
  console.error("Missing NOTION_TOKEN, NOTION_DATABASE_ID, or KAKAO_REST_API_KEY env var.");
  process.exit(1);
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Notion API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function findRowsNeedingInfo() {
  const rows = [];
  let cursor;
  do {
    const body = {
      filter: {
        and: [
          { property: TITLE_PROPERTY, title: { is_not_empty: true } },
          {
            or: [
              { property: AUTHOR_PROPERTY, rich_text: { is_empty: true } },
              { property: PUBLISHER_PROPERTY, rich_text: { is_empty: true } },
            ],
          },
        ],
      },
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const page = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function getTitleText(page) {
  const titleProp = page.properties[TITLE_PROPERTY];
  return titleProp?.title?.map((t) => t.plain_text).join("") ?? "";
}

function isRichTextEmpty(page, propertyName) {
  const prop = page.properties[propertyName];
  return !prop?.rich_text?.length;
}

async function searchKakaoBook(title) {
  const url = new URL("https://dapi.kakao.com/v3/search/book");
  url.searchParams.set("target", "title");
  url.searchParams.set("query", title);
  url.searchParams.set("sort", "accuracy");
  url.searchParams.set("size", "1");

  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Kakao API failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.documents?.[0];
}

function richText(content) {
  return { rich_text: [{ text: { content } }] };
}

async function updatePage(pageId, properties) {
  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function main() {
  const rows = await findRowsNeedingInfo();
  console.log(`Found ${rows.length} row(s) needing book info.`);

  for (const page of rows) {
    const title = getTitleText(page);
    if (!title) continue;

    try {
      const book = await searchKakaoBook(title);
      if (!book) {
        console.warn(`[skip] No Kakao result for "${title}"`);
        continue;
      }

      const properties = {};
      if (isRichTextEmpty(page, AUTHOR_PROPERTY) && book.authors?.length) {
        properties[AUTHOR_PROPERTY] = richText(book.authors.join(", "));
      }
      if (isRichTextEmpty(page, PUBLISHER_PROPERTY) && book.publisher) {
        properties[PUBLISHER_PROPERTY] = richText(book.publisher);
      }

      if (Object.keys(properties).length === 0) {
        console.log(`[skip] "${title}" already filled, nothing to update.`);
        continue;
      }

      await updatePage(page.id, properties);
      console.log(`[updated] "${title}" -> 저자: ${book.authors?.join(", ")}, 출판사: ${book.publisher}`);
    } catch (err) {
      console.error(`[error] "${title}": ${err.message}`);
    }
  }
}

main();
