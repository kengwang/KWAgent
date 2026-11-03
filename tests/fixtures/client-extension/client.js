window.__ModuleLoader__.load({ id: 'kwagent-verification-client', factory() {
  return { apply(ctx) { ctx.effect(() => { document.documentElement.dataset.kwVerificationClient = 'enabled'; return () => { delete document.documentElement.dataset.kwVerificationClient; }; }, 'verification.client'); } };
} });
