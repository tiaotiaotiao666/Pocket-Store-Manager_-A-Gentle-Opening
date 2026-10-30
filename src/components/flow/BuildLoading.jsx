export default function BuildLoading({
  title = '正在构建小程序',
  message,
  steps = [],
  progress = 0,
  active = false,
}) {
  const list = Array.isArray(steps) ? steps : [];
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  const currentIndex = list.length
    ? Math.min(list.length - 1, Math.floor((value / 100) * list.length))
    : -1;

  const rootClass = `build-loading${active ? ' is-active' : ''}`;

  return (
    <section className={rootClass}>
      <div className="build-loading-card">
        <div className="build-dots" aria-hidden="true">
          <span className="build-dot" />
          <span className="build-dot" />
          <span className="build-dot" />
        </div>
        <h2 className="build-loading-title">{title}</h2>
        {message ? <p className="build-loading-message">{message}</p> : null}
        <div className="build-progress">
          <div className="build-progress-bar" style={{ width: `${value}%` }} />
        </div>
        {list.length ? (
          <ol className="build-steps">
            {list.map((step, index) => {
              const stepClass = [
                'build-step',
                index < currentIndex ? 'is-done' : '',
                index === currentIndex ? 'is-current' : '',
              ].filter(Boolean).join(' ');
              return (
                <li className={stepClass} key={step}>
                  <span className="build-step-index">{index + 1}</span>
                  <span className="build-step-label">{step}</span>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </section>
  );
}