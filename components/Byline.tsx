/**
 * HaveAnApp attribution: the maker's quiet signature. The app's name stays the hero.
 * Linked only to the verified official HaveAnApp URL.
 */
export const COMPANY_URL = 'https://haveanapp.com';

export function Byline() {
  return (
    <p className="haveanapp-byline" data-haveanapp="">
      BookNd{' '}
      <a className="haveanapp-byline__by" href={COMPANY_URL} rel="noopener" target="_blank">
        by HaveAnApp
      </a>
    </p>
  );
}
