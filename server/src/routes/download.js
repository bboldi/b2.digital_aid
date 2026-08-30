import { latestKit, buildKit, kitFilename } from '../install-kit.js';
import { translate } from '../i18n.js';

const T = (req, key, vars) => translate(req.lang, key, vars);

// The Install Kit page. Unauthenticated, deliberately (ADR-0015): installing happens at the kid's PC,
// in their browser, with them standing there, and a login means typing the household's admin password
// on the one machine it defends against.
//
// What that buys is a page that must stay boring. No Client names, no server version, no hashes, no
// build history — the version number, the button, and what to do next. Everything else on this server
// stays behind the session cookie.

export default async function downloadRoutes(app) {
  const noindex = (reply) => reply.header('X-Robots-Tag', 'noindex, nofollow');

  app.get('/download', async (req, reply) => {
    const kit = latestKit(app.db, app.db.name);
    noindex(reply);
    return reply.view('download.ejs', {
      title: T(req, 'title.download'),
      showNav: false,
      kit,
    });
  });

  // A stable URL with the version in the download filename, rather than a versioned URL: this is the
  // link that ends up bookmarked and pasted into a message to the other parent, and it should keep
  // meaning "the current one" after the next upload.
  app.get('/download/install-kit.zip', async (req, reply) => {
    const kit = latestKit(app.db, app.db.name);
    noindex(reply);
    // The page hides the button in every not-ok state, so reaching this is a stale tab or a bookmark
    // that outlived its build. Send them back to the page, which explains it, rather than to JSON.
    if (!kit.ok) return reply.redirect('/download');

    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${kitFilename(kit.version)}"`)
      .send(buildKit(kit));
  });

  // An unsigned executable on a private domain has no business in a search index or a scanner corpus.
  app.get('/robots.txt', async (req, reply) =>
    reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
}
