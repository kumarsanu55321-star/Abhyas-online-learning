import { useEffect } from 'react';

const COLORS = ['#E85D75', '#FF8FA3', '#B83250', '#FFB3B3'];
const SHAPES = ['star', 'dot', 'diamond'] as const;

export function useSparkleBurst() {
  useEffect(() => {
    const layers = new Set<HTMLElement>();

    function handleActivation(event: MouseEvent) {
      if (!event.isTrusted) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest<HTMLElement>('button:not(:disabled), a.nav-link, [role="button"]:not([aria-disabled="true"])');
      if (!control || control.closest('[aria-disabled="true"]')) return;

      const bounds = control.getBoundingClientRect();
      const x = event.detail === 0 || !event.clientX ? bounds.left + bounds.width / 2 : event.clientX;
      const y = event.detail === 0 || !event.clientY ? bounds.top + bounds.height / 2 : event.clientY;
      const burst = document.createElement('span');
      burst.className = 'sparkle-burst-layer';
      burst.setAttribute('aria-hidden', 'true');
      burst.style.left = `${x}px`;
      burst.style.top = `${y}px`;
      layers.add(burst);

      let remaining = 8;
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8 + (Math.random() - 0.5) * 0.45;
        const distance = 20 + Math.random() * 25;
        const particle = document.createElement('i');
        particle.className = `sparkle-particle sparkle-${SHAPES[index % SHAPES.length]}`;
        particle.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
        particle.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
        particle.style.setProperty('--sparkle-color', COLORS[Math.floor(Math.random() * COLORS.length)]);
        particle.style.setProperty('--sparkle-size', `${3 + Math.random() * 3}px`);
        particle.style.setProperty('--sparkle-delay', `${Math.random() * 45}ms`);
        particle.addEventListener('animationend', () => {
          remaining -= 1;
          if (!remaining) {
            burst.remove();
            layers.delete(burst);
          }
        }, { once: true });
        burst.appendChild(particle);
      }
      document.body.appendChild(burst);
      if (typeof control.animate === 'function') {
        control.animate([
          { transform: 'scale(1)', offset: 0 },
          { transform: 'scale(.975)', offset: .35 },
          { transform: 'scale(1.012)', offset: .72 },
          { transform: 'scale(1)', offset: 1 },
        ], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }

    document.addEventListener('click', handleActivation, true);
    return () => {
      document.removeEventListener('click', handleActivation, true);
      layers.forEach(layer => layer.remove());
      layers.clear();
    };
  }, []);
}
