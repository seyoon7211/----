/**
 * 웹서비스설계 9주차 실습 · 백엔드 API 서버 (Node.js Express + 1,000건 대량 데이터셋)
 * 3학년 전공심화:
 *   1) 방어적 파라미터 파싱 (parseInt 10진수, 음수 방어, Math.min 100개 상한)
 *   2) ORDER BY 화이트리스트 사전 매핑 (SQL Injection 방어 & id DESC 동점자 결합)
 *   3) 오프셋 페이징 API (/api/posts) + 표준 meta Envelope
 *   4) 고성능 커서 기반(Keyset) 페이징 API (/api/posts/cursor)
 *
 * 실행 방법:
 *   1) npm install express
 *   2) node server.js
 *   3) 브라우저에서 http://localhost:3000 접속
 */

const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.static(__dirname)); // 현재 폴더의 index.html 정적 서빙
app.use(express.json());

// 1,000건의 대용량 더미 게시글 데이터 생성 (1~1000)
const TOPICS = [
  'B-Tree 인덱스 구조와 LIKE %kw% 검색 튜닝 실무',
  '커서 기반(Keyset) 페이지네이션 O(log N) 탐색 원리',
  'ORDER BY SQL Injection과 화이트리스트 매핑 방어',
  'InnoDB 버퍼 풀과 LIMIT OFFSET Cache Thrashing',
  'AbortController를 이용한 비동기 Race Condition 방어',
  '300ms 디바운스(Debounce)와 프론트엔드 입력 최적화',
  'URLSearchParams와 history.pushState 뒤로가기 동기화',
  'InnoDB MVCC 메커니즘과 COUNT(*) 전수 스캔 병목',
  '복합 인덱스(Compound Index) 컬럼 순서의 황금률',
  'Redis 분산 캐시를 활용한 카운트 캐싱 아키텍처',
  'RESTful JSON 페이징 Envelope 규격 표준화',
  'ElasticSearch 역색인(Inverted Index)과 N-gram 전문 검색'
];
const AUTHORS = ['이경수', '김철수', '이영희', '박민수', '정다은', '최준호', '강서연', '윤성호'];

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const topic = TOPICS[i % TOPICS.length];
  const author = AUTHORS[i % AUTHORS.length];
  const views = Math.floor(Math.random() * 5000) + 10;
  const dateNum = String(1000 - i).padStart(4, '0');
  return {
    id,
    title: `[#${id}] ${topic}`,
    content: `게시글 ${id}번의 상세 본문 데이터입니다. DB 인덱스와 페이징 최적화를 실습합니다.`,
    author,
    views,
    createdAt: `2026-${(10 - Math.floor(i / 150)).toString().padStart(2, '0')}-${((i % 28) + 1).toString().padStart(2, '0')}`
  };
});

// 화이트리스트 정렬 정의 (동점자 방지 id 결합)
function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

const SORT_WHITELIST = new Map([
  ['latest', (a, b) =>
    toTimestamp(b.createdAt) - toTimestamp(a.createdAt) ||
    b.id - a.id
  ],

  ['oldest', (a, b) =>
    toTimestamp(a.createdAt) - toTimestamp(b.createdAt) ||
    a.id - b.id
  ],

  ['views', (a, b) =>
    b.views - a.views ||
    b.id - a.id
  ]
]);

function parsePositiveInt(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=인덱스
// ==========================================
app.get('/api/posts', (req, res) => {
  const startTime = process.hrtime();

  // 파라미터 정제 및 방어 코딩
  const rawPage = parseInt(req.query.page, 10);
  const rawLimit = parseInt(req.query.limit, 10);
  const page = (!isNaN(rawPage) && rawPage > 0) ? rawPage : 1;
  const limit = (!isNaN(rawLimit) && rawLimit > 0) ? Math.min(rawLimit, 100) : 10;
  const search = (req.query.search || '').trim().toLowerCase();
  

  // 1) 검색 필터링 (WHERE title LIKE '%search%')
  let filtered = POSTS.filter(p => {
    if (!search) return true;
    return p.title.toLowerCase().includes(search) || p.content.toLowerCase().includes(search);
  });

  // 2) 화이트리스트 정렬 (ORDER BY ...)  완
  const requestedSort =
  typeof req.query.sort === 'string' ? req.query.sort : '';

  const sortKey = SORT_WHITELIST.has(requestedSort)
  ? requestedSort
  : 'latest';

  const sortComparator = SORT_WHITELIST.get(sortKey);
  filtered.sort(sortComparator)

  // 3) 오프셋 계산 및 데이터 슬라이싱
  const totalCount = filtered.length; 
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const diff = process.hrtime(startTime);
  const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      executionTimeMs: Number(executionTimeMs)
    }
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10
// ==========================================
app.get('/api/posts/cursor', (req, res) => {
  const startTime = process.hrtime();

  
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 10), 50);
 

  const rawCursor = typeof req.query.cursor === 'string' 
    ? req.query.cursor.trim()
    : '';

  let cursor = null;

  if (rawCursor) {
    cursor = parsePositiveInt(rawCursor, null);
    if (cursor === null) {
      return res.status(400).json({ error: '유효하지 않은 cursor입니다.' });
    }
  }

  const search = typeof req.query.search === 'string'  // serach
    ? req.query.search.trim().toLowerCase()
    : '';

  const rows = POSTS // 검색
    .filter(post => {
      const title = String(post.title ?? '').toLowerCase();
      const content = String(post.content ?? '').toLowerCase();

      return !search ||
        title.includes(search) ||
        content.includes(search);
    })
    .filter(post => cursor === null || post.id < cursor)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit + 1);

  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit);

  const diff = process.hrtime(startTime);
  const executionTimeMs = Number(
    (diff[0] * 1000 + diff[1] / 1e6).toFixed(2)
  );


  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
   res.json({
    items,
    meta: {
      cursor,
      nextCursor: hasNext && items.length
        ? String(items[items.length - 1].id)
        : null,
      limit,
      hasNext,
      sort: 'id_desc',
      search,
      executionTimeMs
    }
  });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 웹서비스설계 9주차 3학년 전공 실습 서버 구동 완료`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`📦 데이터: 1,000건의 인메모리 게시글 로드 완료`);
  console.log(`====================================================`);
});
