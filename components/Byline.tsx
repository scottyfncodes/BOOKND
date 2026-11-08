/**
 * HaveAnApp attribution: the maker's quiet signature. The app's name stays the hero.
 */
export const COMPANY_NAME = 'HaveAnApp';
/** Set only to the verified official HaveAnApp URL. */
export const COMPANY_URL = 'https://haveanapp.com';

export function Byline({ appName }: { appName?: string }) {
  return (
    <p className="haveanapp-byline" data-haveanapp="">
      {appName ? <>{appName} </> : null}
      <a className="haveanapp-byline__by" href={COMPANY_URL} rel="noopener" target="_blank">
        by {COMPANY_NAME}
      </a>
    </p>
  );
}
