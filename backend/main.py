import json
import os
from pathlib import Path
import re
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
    'syllabus': 'Extract the syllabus into a logical learning path. Return only JSON in this shape: {"topics":[{"name":"...","subtopics":["..."]}]}. Keep the order pedagogically useful. Preserve every supplied syllabus line as a top-level topic in the same wording; add supporting subtopics only when useful. Do not replace syllabus topics with broader headings or invent unrelated content.',
}


def generate_gemini_video(model: str, key: str, video_url: str):
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
    payload = {
        'model': model,
        'input': [
            {'type': 'video', 'uri': canonical_url},
            {'type': 'text', 'text': 'Analyze this lecture and create its summary, key topics, revision notes, flashcards, and practice MCQs. Include timestamps for topics only when you can ground them in the video.'},
        ],
        'system_instruction': SYSTEM_PROMPTS['lecture_video'],
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
            raise HTTPException(status_code=422, detail='Gemini could not analyze this video. It may be private, unlisted, unavailable, or unsupported. Paste a transcript to analyze it manually.') from None
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
        raise HTTPException(status_code=502, detail='Gemini did not return a video analysis. Paste the transcript to analyze it manually.') from None


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
        contents = [{'role': 'model' if item['role'] == 'assistant' else 'user', 'parts': [{'text': item['content']}]} for item in (messages if mode == 'chat' else [{'role': 'user', 'content': prompt}])]
        payload = {
            'systemInstruction': {'parts': [{'text': SYSTEM_PROMPTS[mode] + (f' Use this lecture transcript as the active lesson context:\n{transcript}' if transcript and mode != 'lecture' else '')}]},
            'contents': contents,
            'generationConfig': {'responseMimeType': 'application/json'} if mode in ('flashcards', 'quiz', 'lecture', 'syllabus') else {},
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
        source_messages = messages if mode == 'chat' else [{'role': 'user', 'content': transcript or '\n'.join(item['content'] for item in messages)}]
        result = _request(
            'https://api.groq.com/openai/v1/chat/completions',
            {'model': model, 'messages': [{'role': 'system', 'content': SYSTEM_PROMPTS[mode] + (f' Use this lecture transcript as the active lesson context:\n{transcript}' if transcript and mode != 'lecture' else '')}, *source_messages], 'temperature': 0.4, **({'response_format': {'type': 'json_object'}} if mode in ('flashcards', 'quiz', 'lecture', 'syllabus') else {})},
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
    if request.mode == 'lecture' and request.video_url:
        if os.getenv('AI_PROVIDER', 'gemini').lower() not in ('', 'gemini'):
            raise HTTPException(status_code=503, detail='Direct YouTube video analysis requires AI_PROVIDER=gemini. You can paste the transcript to use the configured provider.')
        key = os.getenv('GEMINI_API_KEY')
        if not key:
            raise HTTPException(status_code=503, detail='Direct YouTube video analysis requires GEMINI_API_KEY in backend/.env. You can paste the transcript to continue.')
        return {'content': generate_gemini_video(os.getenv('GEMINI_MODEL', 'gemini-3.6-flash'), key, request.video_url), 'source': 'gemini_video'}
    if request.mode == 'lecture' and not (request.transcript or '').strip():
        raise HTTPException(status_code=400, detail='Paste a lecture transcript or provide a public YouTube URL. No video content has been analyzed yet.')
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


def _search_syllabus_videos(subject: str, topics: list[dict]) -> list[dict]:
    found: dict[str, dict] = {}
    for topic in topics[:10]:
        result = _youtube_api_get('search', {
            'part': 'snippet', 'type': 'video', 'videoEmbeddable': 'true',
            'q': f'{subject} {topic["name"]} tutorial lecture', 'maxResults': '1', 'order': 'relevance',
        })
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
                'duration': '',
                'view_count': None,
                'relevant_topics': [],
            })
            if topic['name'] not in video['relevant_topics']:
                video['relevant_topics'].append(topic['name'])
        if len(found) >= 10:
            break

    if not found:
        return []
    ids = list(found)[:10]
    details = _youtube_api_get('videos', {'part': 'contentDetails,statistics', 'id': ','.join(ids)})
    for item in details.get('items', []):
        video = found.get(item.get('id'))
        if not video:
            continue
        video['duration'] = _video_duration((item.get('contentDetails') or {}).get('duration', ''))
        views = (item.get('statistics') or {}).get('viewCount')
        video['view_count'] = int(views) if views is not None else None
    return [found[video_id] for video_id in ids]


def _analyze_syllabus_video_coverage(subject: str, topics: list[dict], videos: list[dict]) -> dict[str, dict[str, str]]:
    key = os.getenv('GEMINI_API_KEY')
    if not key or not videos:
        return {}
    model = os.getenv('GEMINI_MODEL', 'gemini-3.6-flash')
    input_items = [{'type': 'video', 'uri': f'https://www.youtube.com/watch?v={video["video_id"]}'} for video in videos]
    video_ids = [video['video_id'] for video in videos]
    input_items.append({'type': 'text', 'text': (
        f'Subject: {subject}. Syllabus topics: {json.dumps([topic["name"] for topic in topics])}. '
        f'The video inputs are in this exact order and have these IDs: {json.dumps(video_ids)}. Return each matching ID exactly from this list. '
        'For every supplied video, compare its actual audio and visual content (not title or metadata) to every syllabus topic. '
        'Return only JSON: {"videos":[{"video_id":"...","topics":[{"name":"exact syllabus topic name","status":"covered|partial|missing|unavailable"}]}]}. '
        'Use covered only when substantially taught, partial when only some relevant material is taught, missing only when the video is accessible and does not address it, and unavailable when the video content cannot be assessed. Include every exact syllabus topic for every video. Do not guess.'
    )})
    try:
        result = _request(
            'https://generativelanguage.googleapis.com/v1beta/interactions',
            {
                'model': model,
                'input': input_items,
                'system_instruction': 'Evaluate only the actual supplied video content. Titles and metadata are not evidence of topic coverage. When uncertain or unable to inspect a video, report unavailable.',
                'response_format': {'type': 'text', 'mime_type': 'application/json'},
            },
            {'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20'},
            timeout=240,
        )
        parts = [part['text'] for step in result.get('steps', []) if step.get('type') == 'model_output' for part in step.get('content', []) if part.get('type') == 'text' and part.get('text')]
        if not parts:
            parts = [item['text'] for item in result.get('outputs', []) if item.get('type') == 'text' and item.get('text')]
        parsed = json.loads(''.join(parts))
        reports = parsed if isinstance(parsed, list) else parsed.get('videos', [])
        valid_names = {topic['name'].lower(): topic['name'] for topic in topics}
        coverage = {}
        for report in reports:
            video_id = report.get('video_id')
            if video_id not in {video['video_id'] for video in videos}:
                continue
            coverage[video_id] = {}
            for topic_report in report.get('topics', []):
                canonical_name = valid_names.get(str(topic_report.get('name', '')).lower())
                status = topic_report.get('status')
                if canonical_name and status in {'covered', 'partial', 'missing', 'unavailable'}:
                    coverage[video_id][canonical_name] = status
        return coverage
    except (HTTPException, KeyError, TypeError, ValueError):
        return {}


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

    topic_names = [topic['name'] for topic in topics]
    unavailable = [{'topic': name, 'status': 'unavailable'} for name in topic_names]
    if not os.getenv('YOUTUBE_API_KEY'):
        return {'topics': topics, 'topic_coverage': unavailable, 'overall_coverage': None, 'videos': [], 'video_error': 'Set YOUTUBE_API_KEY=YOUR_KEY in backend/.env to search YouTube.'}
    try:
        videos = _search_syllabus_videos(request.subject.strip(), topics)
    except HTTPException as error:
        return {'topics': topics, 'topic_coverage': unavailable, 'overall_coverage': None, 'videos': [], 'video_error': error.detail}

    raw_coverage = _analyze_syllabus_video_coverage(request.subject.strip(), topics, videos)
    for video in videos:
        statuses = raw_coverage.get(video['video_id'], {})
        complete = len(statuses) == len(topic_names) and all(status in {'covered', 'partial', 'missing'} for status in statuses.values())
        covered = [name for name in topic_names if statuses.get(name) == 'covered']
        partial = [name for name in topic_names if statuses.get(name) == 'partial']
        missing = [name for name in topic_names if statuses.get(name) == 'missing']
        video['coverage'] = {
            'status': 'estimated' if complete else 'unavailable',
            'percentage': round((len(covered) + 0.5 * len(partial)) * 100 / len(topic_names)) if complete else None,
            'covered_topics': covered,
            'partial_topics': partial,
            'missing_topics': missing,
        }

    topic_coverage = []
    for name in topic_names:
        evidence = [raw_coverage.get(video['video_id'], {}).get(name, 'unavailable') for video in videos]
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
    return {
        'topics': topics,
        'topic_coverage': topic_coverage,
        'overall_coverage': overall_coverage,
        'videos': videos,
        'coverage_note': 'Gemini estimates coverage from public video content. It is not independently verified.' if overall_coverage is not None else 'Coverage unavailable when video content could not be assessed.',
    }
