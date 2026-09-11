import React from 'react';

/**
 * The dashboard's own vocabulary, in reach of the thing it describes.
 *
 * Almost every number on this page is labelled with a word that only means
 * something once the pipeline is explained — "요약 실패 2", "210/210 임베딩",
 * "한도 소진". The words are already defined for the assistant in
 * plugin/ask/context.md; this puts the same definitions in front of the
 * person reading the panels, so the two never drift apart.
 *
 * A native <details> on purpose: it collapses by default, opens on click or
 * Enter, and needs no state, no outside-click handler and no focus trap.
 */

interface Term {
  term: string;
  meaning: string;
}

const TERMS: Term[] = [
  {
    term: '관측치',
    meaning: '대화에서 뽑아 저장한 요약 한 덩어리. 대화 원문이 아니라 10분치를 압축한 것이라 세부는 빠져 있다.',
  },
  {
    term: '요약',
    meaning: '세션에 쌓인 이벤트를 모델에 보내 관측치로 만드는 일. 10분마다 한 번, 새 이벤트가 없으면 하지 않는다.',
  },
  {
    term: '잡',
    meaning: '요약 한 건의 작업 단위. 큐에 쌓였다가 워커가 꺼내 처리한다. 서버가 죽어도 큐에 남아 있다가 살아나면 이어서 처리된다.',
  },
  {
    term: '임베딩',
    meaning: '관측치를 숫자 벡터로 바꾼 것. 뜻이 비슷한 글은 벡터도 가까워서, 단어가 하나도 안 겹쳐도 찾아낼 수 있다.',
  },
  {
    term: '의미 검색',
    meaning: '임베딩 거리로 뜻이 가까운 기록을 찾는 검색. "210/210 임베딩"은 저장된 관측치 전부가 검색 가능하다는 뜻이다.',
  },
  {
    term: '물어보기',
    meaning: '질문에 맞는 관측치를 찾아 그것만 근거로 제미나이가 답하는 오른쪽 채팅. 요약과 같은 무료 한도를 쓴다.',
  },
  {
    term: '한도 소진',
    meaning: '그 모델의 하루 무료 요청을 다 썼다는 뜻. 회색으로 표시되고, 태평양 시간 자정(한국 오후 4~5시)에 풀린다.',
  },
  {
    term: '폴오버',
    meaning: '쓰던 모델이 한도에 걸리거나 과부하(503)면 다음 후보 모델로 자동으로 넘어가는 것. 그래서 하나가 막혀도 멈추지 않는다.',
  },
  {
    term: '재시도',
    meaning: '실패한 잡을 나중에 다시 큐에 올리는 것. 한도 때문에 실패한 잡은 한도가 풀리는 시각까지 기다렸다가 다시 시도한다.',
  },
  {
    term: '훅',
    meaning: '클로드 코드가 대화 중에 이 서버로 이벤트를 보내는 지점. 질문·도구 사용·세션 종료 같은 순간마다 걸려 있다.',
  },
];

export function Glossary() {
  return (
    <details className="glossary">
      <summary className="glossary-toggle" title="이 화면에서 쓰는 용어">
        용어
      </summary>
      <div className="glossary-panel" role="group" aria-label="용어 사전">
        <dl>
          {TERMS.map(({ term, meaning }) => (
            <div className="glossary-item" key={term}>
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
