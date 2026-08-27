#ifndef GRAFT_CLI_VIEW_H
#define GRAFT_CLI_VIEW_H

/* `graft view` — open the 3D viewer in the browser. Builds the SPA on the
 * first run (npm install + npm run build) so the user doesn't have to. */
int mg_view_cmd(int argc, char **argv);

#endif
