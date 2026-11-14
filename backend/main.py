import json
import math
import os
from pathlib import Path
import re
from functools import lru_cache
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).with_name('.env'))
load_dotenv(Path(__file__).resolve().parent.parent / '.env.local')

app = FastAPI(title='Abhyas AI API')
frontend_origins = [origin.strip() for origin in os.getenv('FRONTEND_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origins,
    allow_origin_regex=r'^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$',
    allow_credentials=True,
    allow_methods=['GET', 'POST'],
    allow_headers=['Authorization', 'Content-Type'],
)


class Message(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=20000)


class AssistantRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=40)
    mode: str = 'chat'
    transcript: str | None = Field(default=None, max_length=100000)
    video_url: str | None = None


class SyllabusRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=120)
    syllabus: str = Field(min_length=1, max_length=100000)


def _request(url: str, payload: dict | None = None, headers: dict | None = None, timeout: int = 45):
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=data, headers=headers or {}, method='POST' if data else 'GET')
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except HTTPError as error:
        error.read()
        if error.code == 503:
            raise HTTPException(status_code=503, detail='The AI provider is temporarily busy. Please try again shortly.') from None
        if error.code == 429:
            raise HTTPException(status_code=429, detail='The AI provider rate limit was reached. Please try again shortly.') from None
        if error.code in (401, 403):
            raise HTTPException(status_code=502, detail='The AI provider rejected its backend credentials or model configuration. Check backend/.env.') from None
        raise HTTPException(status_code=502, detail=f'AI provider error ({error.code}). Please try again.') from None
    except URLError:
        raise HTTPException(status_code=502, detail='Could not reach the AI provider. Please try again.') from None


def current_user(authorization: str | None = Header(default=None)):
    supabase_url = os.getenv('SUPABASE_URL') or os.getenv('VITE_SUPABASE_URL')
    anon_key = os.getenv('SUPABASE_ANON_KEY') or os.getenv('VITE_SUPABASE_ANON_KEY')
    if not supabase_url or not anon_key:
        raise HTTPException(status_code=503, detail='Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env to enable AI requests.')
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='Sign in to use the AI assistant.')
    request = Request(
        f'{supabase_url.rstrip("/")}/auth/v1/user',
        headers={'apikey': anon_key, 'Authorization': authorization},
    )
    try:
        with urlopen(request, timeout=10) as response:
            user = json.loads(response.read())
    except (HTTPError, URLError, ValueError):
        raise HTTPException(status_code=401, detail='Your session could not be verified. Sign in again.') from None
    return user


SYSTEM_PROMPTS = {
    'chat': 'You are Abhyas, a patient study assistant. Answer accurately in simple language, with a concrete real-world example when useful. Match the student\'s language: English, Hindi, or Hinglish. Use the conversation for follow-up context. If unsure, say so.',
    'summary': 'Summarize the supplied conversation or lesson in a concise, student-friendly way. Match the student\'s language.',
    'notes': 'Create structured revision notes from the supplied conversation or lesson. Use clear headings, definitions, key points, concise bullets, and simple examples. Match the student\'s language.',
    'flashcards': 'Create 6 useful revision flashcards from the supplied conversation or lesson. Return only JSON: {"flashcards":[{"question":"...","answer":"..."}]}. Do not add facts absent from the source.',
    'quiz': 'Create 5 interactive practice MCQs from the supplied conversation or lesson. Return only JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"..."}]}. answer is a zero-based option index. Ensure exactly one correct option. Do not add facts absent from the source.',
    'lecture': 'Analyze only the supplied transcript. Return JSON: {"summary":"...","topics":[{"name":"...","timestamp":"..."}],"notes":"...","flashcards":[{"question":"...","answer":"..."}],"quiz":{"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"..."}]}}. Include a topic timestamp only when that exact time appears in the transcript. Do not infer facts from the title, URL, or outside knowledge. If the transcript is insufficient, say so.',
    'lecture_video': 'Analyze the actual supplied YouTube video input, including its audio and visuals. Do not infer video content from its title or URL. Return JSON: {"summary":"...","topics":[{"name":"...","timestamp":"..."}],"notes":"...","flashcards":[{"question":"...","answer":"..."}],"quiz":{"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"..."}]}}. Include timestamps only for moments you can locate in the video; omit them when uncertain. Base every item on the video content. If you cannot access or understand the video, clearly say so instead of guessing.',
    'recap_video': 'Create a concise recap designed to take about 60 seconds to read. Analyze the actual supplied YouTube video, including its audio and visuals. Do not infer content from its title, URL, thumbnail, or outside facts. Return only JSON: {"main_concepts":["..."],"definitions":[{"term":"...","definition":"..."}],"key_takeaways":["..."],"example":"One clearly labeled illustrative example grounded in the video concepts, not claimed to be spoken in the lecture; explain if no grounded example is possible.","revision_checklist":["..."]}. Include only details supported by video content. If you cannot access or understand enough of the video, return empty arrays and explain the limitation in key_takeaways rather than guessing.',
    'reverse_lecture': 'Evaluate the student\'s explanation of the stated topic. Be encouraging and precise. Judge conceptual correctness, identify specific strengths and gaps, explain corrections, and give 2-3 concrete next steps. Do not claim the student said things they did not say. Return only JSON: {"score":0,"feedback":"...","strengths":["..."],"gaps":["..."],"next_steps":["..."],"follow_up_question":"..."}. Score 0-100 based on accuracy and completeness; do not reward length.',
    'recap': 'Create a quick recap designed to take about 60 seconds to read (roughly 110-140 words). Use only the supplied transcript or lecture notes. Do not use the video title, URL, or outside facts, and do not imply details were spoken unless the source supports them. Return only JSON: {"main_concepts":["..."],"definitions":[{"term":"...","definition":"..."}],"key_takeaways":["..."],"example":"One clearly labeled illustrative real-world example derived from the supplied concepts; do not claim it was in the lecture. If the source is too limited to ground an example, say that.","revision_checklist":["..."]}. If the source is empty or does not contain enough lecture content, return concise empty arrays and explain the limitation in key_takeaways instead of guessing.',
    'syllabus': 'Extract the syllabus into a logical learning path. Return only JSON in this shape: {"topics":[{"name":"...","subtopics":["..."]}]}. Keep the order pedagogically useful. Preserve every supplied syllabus line as a top-level topic in the same wording; add supporting subtopics only when useful. Do not replace syllabus topics with broader headings or invent unrelated content.',
}


def generate_gemini_video(model: str, key: str, video_url: str, mode: str = 'lecture'):
    try:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(video_url)
        host = parsed.hostname.lower().removeprefix('www.') if parsed.hostname else ''
        video_id = (parse_qs(parsed.query).get('v') or [''])[0] if host in ('youtube.com', 'm.youtube.com') else parsed.path.strip('/').split('/')[0] if host == 'youtu.be' else ''
        if not video_id or not all(char.isalnum() or char in '_-' for char in video_id) or len(video_id) != 11:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail='Enter a valid YouTube video URL.') from None

    canonical_url = f'https://www.youtube.com/watch?v={video_id}'
    is_recap = mode == 'recap'
    payload = {
        'model': model,
        'input': [
            {'type': 'video', 'uri': canonical_url},
            {'type': 'text', 'text': 'Create a 60-second recap of this lecture from its actual video content.' if is_recap else 'Analyze this lecture and create its summary, key topics, revision notes, flashcards, and practice MCQs. Include timestamps for topics only when you can ground them in the video.'},
        ],
        'system_instruction': SYSTEM_PROMPTS['recap_video' if is_recap else 'lecture_video'],
        'response_format': {'type': 'text', 'mime_type': 'application/json'},
    }
    try:
        result = _request(
            'https://generativelanguage.googleapis.com/v1beta/interactions',
            payload,
            {'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20'},
            timeout=180,
        )
    except HTTPException as error:
        if error.status_code in (400, 404, 422):
            raise HTTPException(status_code=422, detail='Gemini could not analyze this video. It may be private, unavailable, or unsupported. Paste the actual transcript or lecture notes to generate a recap.') from None
        raise
    try:
        steps = result.get('steps', [])
        text_parts = [part['text'] for step in steps if step.get('type') == 'model_output' for part in step.get('content', []) if part.get('type') == 'text' and part.get('text')]
        if not text_parts:
            text_parts = [item['text'] for item in result.get('outputs', []) if item.get('type') == 'text' and item.get('text')]
        if not text_parts:
            raise ValueError
        return ''.join(text_parts)
    except (AttributeError, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=502, detail='Gemini did not return a video analysis. Paste the actual transcript or lecture notes to continue.') from None


def generate(messages: list[dict], mode: str, transcript: str | None):
    provider = os.getenv('AI_PROVIDER', '').lower()
    if not provider:
        provider = 'gemini' if os.getenv('GEMINI_API_KEY') else 'groq'
    if provider == 'gemini':
        key = os.getenv('GEMINI_API_KEY')
        if not key:
            raise HTTPException(status_code=503, detail='Add GEMINI_API_KEY to backend/.env (or set AI_PROVIDER=groq and add GROQ_API_KEY).')
        model = os.getenv('GEMINI_MODEL', 'gemini-3.6-flash')
        prompt = messages[-1]['content']
        if mode != 'chat':
            source = transcript if mode == 'lecture' else '\n'.join(f"{item['role']}: {item['content']}" for item in messages)
            prompt = f'{source}\n\nTask: {messages[-1]["content"]}' if mode == 'lecture' else source
        if mode == 'chat':
            # Keep recent conversational context while bounding per-request tokens and provider cost.
            recent_messages = messages[-8:]
            contents = [{'role': 'model' if item['role'] == 'assistant' else 'user', 'parts': [{'text': item['content'][-3000:]}]} for item in recent_messages]
        else:
            contents = [{'role': 'user', 'parts': [{'text': prompt[-24000:]}]}]
        payload = {
            'systemInstruction': {'parts': [{'text': SYSTEM_PROMPTS[mode] + (f' Use this lecture transcript as the active lesson context:\n{transcript}' if transcript and mode != 'lecture' else '')}]},
            'contents': contents,
            'generationConfig': {'responseMimeType': 'application/json'} if mode in ('flashcards', 'quiz', 'lecture', 'reverse_lecture', 'recap', 'syllabus') else {},
        }
        result = _request(
            f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
            payload,
            {'Content-Type': 'application/json', 'x-goog-api-key': key},
        )
        try:
            return ''.join(part.get('text', '') for part in result['candidates'][0]['content']['parts'])
        except (KeyError, IndexError, TypeError):
            raise HTTPException(status_code=502, detail='The AI provider returned an empty response. Please try again.') from None

    if provider == 'groq':
        key = os.getenv('GROQ_API_KEY')
        if not key:
            raise HTTPException(status_code=503, detail='Add GROQ_API_KEY to backend/.env (or set AI_PROVIDER=gemini and add GEMINI_API_KEY).')
        model = os.getenv('GROQ_MODEL', 'llama-3.3-70b-versatile')
        source_messages = ([{'role': item['role'], 'content': item['content'][-3000:]} for item in messages[-8:]] if mode == 'chat' else [{'role': 'user', 'content': (transcript or '\n'.join(item['content'] for item in messages))[-24000:]}])
        result = _request(
            'https://api.groq.com/openai/v1/chat/completions',
            {'model': model, 'messages': [{'role': 'system', 'content': SYSTEM_PROMPTS[mode] + (f' Use this lecture transcript as the active lesson context:\n{transcript}' if transcript and mode != 'lecture' else '')}, *source_messages], 'temperature': 0.4, **({'response_format': {'type': 'json_object'}} if mode in ('flashcards', 'quiz', 'lecture', 'reverse_lecture', 'recap', 'syllabus') else {})},
            {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'},
        )
        try:
            return result['choices'][0]['message']['content']
        except (KeyError, IndexError, TypeError):
            raise HTTPException(status_code=502, detail='The AI provider returned an empty response. Please try again.') from None
    raise HTTPException(status_code=503, detail='Set AI_PROVIDER to gemini or groq in backend/.env.')


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/api/assistant')
def assistant(request: AssistantRequest, _user=Depends(current_user)):
    if request.mode not in SYSTEM_PROMPTS:
        raise HTTPException(status_code=400, detail='Unknown assistant action.')
    if request.mode in ('lecture', 'recap') and request.video_url:
        if os.getenv('AI_PROVIDER', 'gemini').lower() not in ('', 'gemini'):
            raise HTTPException(status_code=503, detail='Direct YouTube video analysis requires AI_PROVIDER=gemini. You can paste the transcript to use the configured provider.')
        key = os.getenv('GEMINI_API_KEY')
        if not key:
            raise HTTPException(status_code=503, detail='Direct YouTube video analysis requires GEMINI_API_KEY in backend/.env. You can paste the transcript to continue.')
        return {'content': generate_gemini_video(os.getenv('GEMINI_MODEL', 'gemini-3.6-flash'), key, request.video_url, request.mode), 'source': 'gemini_video'}
    if request.mode == 'lecture' and not (request.transcript or '').strip():
        raise HTTPException(status_code=400, detail='Paste a lecture transcript or provide a public YouTube URL. No video content has been analyzed yet.')
    if request.mode == 'recap' and not (request.transcript or '').strip():
        raise HTTPException(status_code=400, detail='Paste the actual lecture transcript or notes before generating a recap. The video title and URL are not enough to analyze lecture content.')
    messages = [{'role': item.role, 'content': item.content} for item in request.messages]
    return {'content': generate(messages, request.mode, request.transcript)}


def _youtube_api_get(endpoint: str, params: dict):
    key = os.getenv('YOUTUBE_API_KEY')
    if not key:
        raise HTTPException(status_code=503, detail='Set YOUTUBE_API_KEY=YOUR_KEY in backend/.env to enable YouTube recommendations.')
    url = f'https://www.googleapis.com/youtube/v3/{endpoint}?{urlencode({**params, "key": key})}'
    try:
        with urlopen(Request(url), timeout=20) as response:
            return json.loads(response.read())
    except HTTPError as error:
        error.read()
        if error.code == 403:
            raise HTTPException(status_code=502, detail='YouTube Data API rejected the request. Check the API key, YouTube Data API v3 access, and quota.') from None
        raise HTTPException(status_code=502, detail=f'YouTube Data API request failed ({error.code}).') from None
    except (URLError, ValueError):
        raise HTTPException(status_code=502, detail='Could not reach the YouTube Data API.') from None


def _video_duration(value: str) -> str:
    match = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', value or '')
    if not match:
        return ''
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return f'{hours}:{minutes:02}:{seconds:02}' if hours else f'{minutes}:{seconds:02}'


def _flatten_syllabus_topics(topics: list[dict]) -> list[str]:
    concepts = []
    for topic in topics:
        for value in [topic.get('name', ''), *(topic.get('subtopics') or [])]:
            name = str(value).strip()
            if name and name.casefold() not in {concept.casefold() for concept in concepts}:
                concepts.append(name)
    return concepts


@lru_cache(maxsize=64)
def _youtube_search_query(query: str, max_results: int):
    return _youtube_api_get('search', {
        'part': 'snippet', 'type': 'video', 'videoEmbeddable': 'true',
        'q': query, 'maxResults': str(max_results), 'order': 'relevance',
    })


@lru_cache(maxsize=64)
def _youtube_video_details(video_ids: tuple[str, ...]):
    return _youtube_api_get('videos', {'part': 'snippet,contentDetails,statistics', 'id': ','.join(video_ids)})


def _search_syllabus_videos(subject: str, topics: list[dict]) -> list[dict]:
    found: dict[str, dict] = {}
    concepts = _flatten_syllabus_topics(topics)[:10]
    if not concepts:
        return []
    search_terms = []
    for topic in topics:
        root = str(topic.get('name', '')).strip()
        if root:
            search_terms.append((root, root))
            search_terms.extend((f'{root} {subtopic}', subtopic) for subtopic in topic.get('subtopics', []) if str(subtopic).strip())
    search_terms = search_terms[:10]
    per_query = max(1, min(10, (12 + len(search_terms) - 1) // len(search_terms)))
    for query, concept in search_terms:
        result = _youtube_search_query(f'{subject} {query} tutorial lecture', per_query)
        for item in result.get('items', []):
            video_id = (item.get('id') or {}).get('videoId')
            snippet = item.get('snippet') or {}
            if not video_id:
                continue
            video = found.setdefault(video_id, {
                'video_id': video_id,
                'title': snippet.get('title', ''),
                'thumbnail': (snippet.get('thumbnails') or {}).get('high', {}).get('url') or (snippet.get('thumbnails') or {}).get('medium', {}).get('url') or (snippet.get('thumbnails') or {}).get('default', {}).get('url', ''),
                'channel': snippet.get('channelTitle', ''),
                'description': snippet.get('description', '')[:2000],
                'duration': '',
                'view_count': None,
                'relevant_topics': [],
            })
            if concept not in video['relevant_topics']:
                video['relevant_topics'].append(concept)
        if len(found) >= 20:
            break

    if not found:
        return []
    ids = tuple(list(found)[:20])
    details = _youtube_video_details(ids)
    available_ids = set()
    for item in details.get('items', []):
        video = found.get(item.get('id'))
        if not video:
            continue
        available_ids.add(item['id'])
        snippet = item.get('snippet') or {}
        video['title'] = snippet.get('title', video['title'])
        video['channel'] = snippet.get('channelTitle', video['channel'])
        video['description'] = snippet.get('description', video['description'])[:2000]
        thumbs = snippet.get('thumbnails') or {}
        video['thumbnail'] = thumbs.get('high', {}).get('url') or thumbs.get('medium', {}).get('url') or thumbs.get('default', {}).get('url') or video['thumbnail']
        video['duration'] = _video_duration((item.get('contentDetails') or {}).get('duration', ''))
        views = (item.get('statistics') or {}).get('viewCount')
        video['view_count'] = int(views) if views is not None else None
    return [found[video_id] for video_id in ids if video_id in available_ids]


def _metadata_relevance(video: dict, concepts: list[str], main_topics: list[str]) -> int:
    title = str(video.get('title', '')).casefold()
    description = str(video.get('description', '')).casefold()
    if not concepts or not (title or description):
        return 0

    def match_score(text: str, concept: str) -> float:
        if concept.casefold() in text:
            return 1.0
        terms = [term for term in re.findall(r'[a-z0-9]+', concept.casefold()) if len(term) > 2]
        return sum(term in text for term in terms) / len(terms) if terms else 0.0

    scores = [0.7 * match_score(title, concept) + 0.3 * match_score(description, concept) for concept in concepts]
    root_scores = [0.7 * match_score(title, topic) + 0.3 * match_score(description, topic) for topic in main_topics]
    concept_relevance = sum(scores) / len(scores)
    main_topic_relevance = max(root_scores, default=0.0)
    return round((0.6 * concept_relevance + 0.4 * main_topic_relevance) * 100)


def _analyze_syllabus_video_batch(subject: str, concepts: list[str], videos: list[dict]) -> dict[str, dict]:
    key = os.getenv('GEMINI_API_KEY')
    if not key or not videos:
        return {}
    model = os.getenv('GEMINI_MODEL', 'gemini-3.6-flash')
    video_ids = [video['video_id'] for video in videos]
    input_items = [{'type': 'video', 'uri': f'https://www.youtube.com/watch?v={video_id}'} for video_id in video_ids]
    metadata = [
        {'video_id': video['video_id'], 'title': video.get('title', ''), 'description': video.get('description', '')[:800]}
        for video in videos
    ]
    input_items.append({'type': 'text', 'text': (
        f'Subject: {subject}. Concepts: {json.dumps(concepts)}. '
        f'Video inputs in order with IDs: {json.dumps(video_ids)}. Metadata for matching IDs: {json.dumps(metadata)}. '
        'For each video evaluate the actual video content, not its title, for every concept. Also score conceptual relevance and educational usefulness from 0 to 100. '
        'If the video content is inaccessible, set video_status to unavailable and give only a metadata_relevance_score from the supplied title/description; mark all topic statuses unavailable. '
        'Return JSON: {"videos":[{"video_id":"exact ID","video_status":"analyzed|unavailable","relevance_score":0,"educational_usefulness":0,"metadata_relevance_score":0,"topics":[{"name":"exact concept","status":"covered|partial|missing|unavailable"}]}]}. Include every exact concept for every video. Do not claim transcript access; assess only actual video content you can inspect and never infer coverage from metadata.'
    )})
    try:
        result = _request(
            'https://generativelanguage.googleapis.com/v1beta/interactions',
            {
                'model': model,
                'input': input_items,
                'system_instruction': 'Use actual video content as the sole evidence for covered, partial, or missing topics. If content cannot be inspected, return unavailable for content coverage and a separately labeled metadata relevance estimate.',
                'response_format': {'type': 'text', 'mime_type': 'application/json'},
            },
            {'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20'},
            timeout=180,
        )
        parts = [part['text'] for step in result.get('steps', []) if step.get('type') == 'model_output' for part in step.get('content', []) if part.get('type') == 'text' and part.get('text')]
        if not parts:
            parts = [item['text'] for item in result.get('outputs', []) if item.get('type') == 'text' and item.get('text')]
        parsed = json.loads(''.join(parts))
        reports = parsed if isinstance(parsed, list) else parsed.get('videos', [])
        valid_names = {name.casefold(): name for name in concepts}
        coverage = {}
        for report in reports:
            video_id = report.get('video_id')
            if video_id not in video_ids:
                continue
            topic_statuses = {}
            for topic_report in report.get('topics', []):
                canonical_name = valid_names.get(str(topic_report.get('name', '')).casefold())
                status = topic_report.get('status')
                if canonical_name and status in {'covered', 'partial', 'missing', 'unavailable'}:
                    topic_statuses[canonical_name] = status
            complete = len(topic_statuses) == len(concepts) and all(status in {'covered', 'partial', 'missing'} for status in topic_statuses.values())
            coverage[video_id] = {
                'content_available': report.get('video_status') != 'unavailable' and complete,
                'topics': topic_statuses,
                'relevance_score': report.get('relevance_score'),
                'educational_usefulness': report.get('educational_usefulness'),
                'metadata_relevance_score': report.get('metadata_relevance_score'),
            }
        return coverage
    except (HTTPException, KeyError, TypeError, ValueError):
        return {}


def _analyze_syllabus_video_coverage(subject: str, concepts: list[str], videos: list[dict]) -> dict[str, dict]:
    coverage = {}
    batch_size = 2
    # Search can return up to 20 items; spend Gemini video requests on the six strongest metadata matches.
    shortlist = sorted(videos, key=lambda video: _metadata_relevance(video, concepts, [item for item in concepts[:4]]), reverse=True)[:6]
    for offset in range(0, len(shortlist), batch_size):
        batch = shortlist[offset:offset + batch_size]
        results = _analyze_syllabus_video_batch(subject, concepts, batch)
        if not results:
            break
        coverage.update(results)
    return coverage


def _recommend_syllabus_videos(videos: list[dict], topics: list[dict], analysis: dict[str, dict]) -> list[dict]:
    concepts = _flatten_syllabus_topics(topics)
    main_topics = [str(topic['name']) for topic in topics if topic.get('name')]
    candidates = []
    for video in videos:
        result = analysis.get(video['video_id'], {})
        statuses = result.get('topics', {}) if result.get('content_available') else {}
        content_available = bool(result.get('content_available'))
        metadata_score = _metadata_relevance(video, concepts, main_topics)
        if not content_available and isinstance(result.get('metadata_relevance_score'), (int, float)):
            metadata_score = max(0, min(100, round(result['metadata_relevance_score'])))
        covered = [name for name in concepts if statuses.get(name) == 'covered']
        partial = [name for name in concepts if statuses.get(name) == 'partial']
        missing = [name for name in concepts if statuses.get(name) == 'missing']
        coverage_score = round((len(covered) + 0.5 * len(partial)) * 100 / len(concepts)) if content_available and concepts else None
        if content_available:
            relevance = result.get('relevance_score')
            quality = result.get('educational_usefulness')
            relevance = max(0, min(100, round(relevance))) if isinstance(relevance, (int, float)) else metadata_score
            quality = max(0, min(100, round(quality))) if isinstance(quality, (int, float)) else relevance
            relevance_source = 'gemini_video'
            # Rank by marginal syllabus coverage (55%), relevance (30%), and teaching usefulness (15%).
            rank_score = 0.55 * coverage_score + 0.3 * relevance + 0.15 * quality
            status = 'estimated'
        else:
            relevance = metadata_score
            quality = None
            relevance_source = 'metadata' if relevance > 0 else 'unavailable'
            popularity = min(100, 12 * math.log10(max(1, video.get('view_count') or 1)))
            rank_score = 0.85 * relevance + 0.15 * popularity
            coverage_score = None
            status = 'metadata' if relevance_source == 'metadata' else 'unavailable'
            covered, partial, missing = [], [], []
        video['coverage'] = {
            'status': status,
            'source': relevance_source,
            'percentage': coverage_score,
            'relevance_score': relevance if relevance_source != 'unavailable' else None,
            'covered_topics': covered,
            'partial_topics': partial,
            'missing_topics': missing,
        }
        video['_rank_score'] = rank_score
        video['_quality_score'] = quality or 0
        video['_content_statuses'] = statuses
        candidates.append(video)

    selected = []
    contribution = {concept: 0.0 for concept in concepts}
    pool = [video for video in candidates if video['coverage']['relevance_score'] is not None and video['coverage']['relevance_score'] >= 15]
    while pool and len(selected) < 5:
        def marginal_score(video):
            if video['coverage']['source'] != 'gemini_video':
                return 0.8 * video['_rank_score'] + 0.2 * min(100, len(video.get('relevant_topics', [])) * 20)
            gain = sum(
                # A covered concept contributes 1, a partial concept 0.5, and a missing concept 0.
                max(0.0, (1.0 if video['_content_statuses'].get(concept) == 'covered' else 0.5 if video['_content_statuses'].get(concept) == 'partial' else 0.0) - contribution[concept])
                for concept in concepts
            ) * 100 / max(1, len(concepts))
            return 0.55 * gain + 0.3 * video['coverage']['relevance_score'] + 0.15 * video['_quality_score']

        best = max(pool, key=marginal_score)
        if marginal_score(best) < 15:
            break
        pool.remove(best)
        selected.append(best)
        if best['coverage']['source'] == 'gemini_video':
            for concept in concepts:
                value = 1.0 if best['_content_statuses'].get(concept) == 'covered' else 0.5 if best['_content_statuses'].get(concept) == 'partial' else 0.0
                contribution[concept] = max(contribution[concept], value)
    for video in selected:
        video.pop('_rank_score', None)
        video.pop('_quality_score', None)
        video.pop('_content_statuses', None)
    return selected
@app.post('/api/syllabus/analyze')
def analyze_syllabus(request: SyllabusRequest, _user=Depends(current_user)):
    provider = os.getenv('AI_PROVIDER', '').lower() or ('gemini' if os.getenv('GEMINI_API_KEY') else 'groq')
    if provider != 'gemini':
        raise HTTPException(status_code=503, detail='Syllabus analysis requires Gemini. Set AI_PROVIDER=gemini and GEMINI_API_KEY in backend/.env.')
    prompt = f'Subject: {request.subject.strip()}\nSyllabus:\n{request.syllabus.strip()}'
    try:
        parsed = json.loads(generate([{'role': 'user', 'content': prompt}], 'syllabus', None))
        topics = [
            {'name': str(item.get('name', '')).strip(), 'subtopics': [str(value).strip() for value in item.get('subtopics', []) if str(value).strip()]}
            for item in parsed.get('topics', []) if str(item.get('name', '')).strip()
        ]
        if not topics:
            raise ValueError
    except (HTTPException, AttributeError, TypeError, ValueError) as error:
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(status_code=502, detail='Gemini could not extract syllabus topics. Add more detail and try again.') from None

    concepts = _flatten_syllabus_topics(topics)
    unavailable = [{'topic': name, 'status': 'unavailable'} for name in concepts]
    if not os.getenv('YOUTUBE_API_KEY'):
        return {'topics': topics, 'topic_coverage': unavailable, 'overall_coverage': None, 'videos': [], 'candidate_count': 0, 'video_error': 'Set YOUTUBE_API_KEY=YOUR_KEY in backend/.env to search YouTube.'}
    try:
        candidates = _search_syllabus_videos(request.subject.strip(), topics)
    except HTTPException as error:
        return {'topics': topics, 'topic_coverage': unavailable, 'overall_coverage': None, 'videos': [], 'candidate_count': 0, 'video_error': error.detail}

    raw_coverage = _analyze_syllabus_video_coverage(request.subject.strip(), concepts, candidates)
    videos = _recommend_syllabus_videos(candidates, topics, raw_coverage)

    topic_coverage = []
    content_videos = [raw_coverage.get(video['video_id'], {}) for video in videos if raw_coverage.get(video['video_id'], {}).get('content_available')]
    for name in concepts:
        evidence = [video.get('topics', {}).get(name, 'unavailable') for video in content_videos]
        if 'covered' in evidence:
            status = 'covered'
        elif 'partial' in evidence:
            status = 'partial'
        elif evidence and all(value == 'missing' for value in evidence):
            status = 'missing'
        else:
            status = 'unavailable'
        topic_coverage.append({'topic': name, 'status': status})
    enough_evidence = bool(topic_coverage) and all(item['status'] != 'unavailable' for item in topic_coverage)
    overall_coverage = round(sum(1 if item['status'] == 'covered' else 0.5 if item['status'] == 'partial' else 0 for item in topic_coverage) * 100 / len(topic_coverage)) if enough_evidence else None
    has_metadata = any(video['coverage']['source'] == 'metadata' for video in videos)
    evaluated_candidate_count = sum(1 for result in raw_coverage.values() if result.get('content_available'))
    if overall_coverage is not None:
        coverage_note = 'Coverage score: covered=1, partial=0.5, missing=0 across syllabus concepts. Gemini estimates from public video content; not independently verified.'
    elif evaluated_candidate_count < len(candidates):
        coverage_note = 'Gemini could not assess all candidate videos. Content coverage is unavailable for those videos; metadata relevance estimates are labeled separately.'
    else:
        coverage_note = 'Coverage is unavailable when Gemini cannot assess the actual video content.'
    return {
        'topics': topics,
        'topic_coverage': topic_coverage,
        'overall_coverage': overall_coverage,
        'videos': videos,
        'candidate_count': len(candidates),
        'evaluated_candidate_count': evaluated_candidate_count,
        'coverage_note': coverage_note + (' Metadata relevance is available for some candidates.' if has_metadata and overall_coverage is None else ''),
    }
