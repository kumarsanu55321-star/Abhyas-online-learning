export type YouTubePlayer = { destroy: () => void };
type PlayerError = { data: number };
type PlayerReady = { target: YouTubePlayer & { getIframe: () => HTMLIFrameElement } };
type PlayerConstructor = new (element: HTMLElement, options: { videoId?: string; events?: { onReady?: (event: PlayerReady) => void; onError?: (event: PlayerError) => void } }) => YouTubePlayer;

declare global {
  interface Window {
    YT?: { Player: PlayerConstructor };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | undefined;

export function loadYouTubePlayerApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previousReady?.(); resolve(); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { apiPromise = undefined; reject(new Error('The YouTube player could not be loaded.')); };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function extractYouTubeId(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/')[1] || '';
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else if (/^\/(embed|shorts|live)\//.test(url.pathname)) id = url.pathname.split('/')[2] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
