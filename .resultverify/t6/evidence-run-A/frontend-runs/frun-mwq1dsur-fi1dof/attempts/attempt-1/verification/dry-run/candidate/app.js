const session = require('./services/session.js');
const visitStore = require('./state/visit-store.js');

App({
  onLaunch() {
    session.load();
    visitStore.load();
  },
});