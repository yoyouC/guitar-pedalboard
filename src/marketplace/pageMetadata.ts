export type MarketplacePageKind = 'preset' | 'collection' | 'creator';

export interface MarketplacePageMetadata {
  title: string;
  description: string;
  canonicalUrl: string;
  robots: 'index,follow' | 'noindex,nofollow';
}

export function marketplacePageMetadata(input: {
  kind: MarketplacePageKind;
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'unlisted' | 'withdrawn';
  origin: string;
}): MarketplacePageMetadata {
  const path = input.kind === 'preset'
    ? `/marketplace/presets/${encodeURIComponent(input.id)}`
    : input.kind === 'collection'
      ? `/marketplace/collections/${encodeURIComponent(input.id)}`
      : `/creators/id/${encodeURIComponent(input.id)}`;
  return {
    title: `${input.title} · Guitar Pedalboard`,
    description: input.description || 'Guitar Pedalboard 音色广场内容',
    canonicalUrl: new URL(path, input.origin).toString(),
    robots: input.visibility === 'public' ? 'index,follow' : 'noindex,nofollow',
  };
}

export function useMarketplacePageMetadata(
  input: Omit<Parameters<typeof marketplacePageMetadata>[0], 'origin'> | null,
): void {
  const kind = input?.kind;
  const id = input?.id;
  const title = input?.title;
  const descriptionText = input?.description;
  const visibility = input?.visibility;
  useEffect(() => {
    if (!kind || !id || title === undefined || descriptionText === undefined || !visibility) return;
    const metadata = marketplacePageMetadata({
      kind,
      id,
      title,
      description: descriptionText,
      visibility,
      origin: window.location.origin,
    });
    const previousTitle = document.title;
    document.title = metadata.title;
    const description = setHeadValue('meta[name="description"]', 'meta', 'content', metadata.description, {
      name: 'description',
    });
    const robots = setHeadValue('meta[name="robots"]', 'meta', 'content', metadata.robots, {
      name: 'robots',
    });
    const canonical = setHeadValue('link[rel="canonical"]', 'link', 'href', metadata.canonicalUrl, {
      rel: 'canonical',
    });
    return () => {
      document.title = previousTitle;
      description.restore();
      robots.restore();
      canonical.restore();
    };
  }, [descriptionText, id, kind, title, visibility]);
}

function setHeadValue(
  selector: string,
  tagName: 'meta' | 'link',
  property: 'content' | 'href',
  value: string,
  attributes: Record<string, string>,
): { restore(): void } {
  let element = document.querySelector<HTMLElement>(selector);
  const created = !element;
  if (!element) {
    element = document.createElement(tagName);
    for (const [name, attributeValue] of Object.entries(attributes)) {
      element.setAttribute(name, attributeValue);
    }
    document.head.append(element);
  }
  const previous = element.getAttribute(property);
  element.setAttribute(property, value);
  return {
    restore() {
      if (created) element?.remove();
      else if (previous === null) element?.removeAttribute(property);
      else element?.setAttribute(property, previous);
    },
  };
}
import { useEffect } from 'react';
