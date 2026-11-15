/**
 * ClickSpark (react bits) — a small canvas-2D spark burst on every click,
 * mounted once at the app root (see ClickSparkLazy.jsx) so every page in
 * every role gets it without three separate instances fighting for the
 * same clicks. Canvas 2D, not WebGL -- always available, no capability
 * gate needed beyond prefers-reduced-motion.
 *
 * IT ONLY DRAWS WHILE A BURST IS ON SCREEN. The original ran its
 * requestAnimationFrame loop forever, clearing the canvas every frame
 * whether or not anything had been tapped -- and the canvas was sized to
 * the whole app container, so on a long page that was a 390 x 3000 px
 * bitmap cleared and re-uploaded to the GPU ~60-120 times a second on
 * every screen, for as long as the app was open. That was a large part of
 * "the app is lagging". Now a tap starts the loop, the loop stops itself
 * once the last spark fades (~0.4 s), and the canvas is the size of the
 * viewport it is fixed to.
 */
import { useRef, useEffect, useCallback } from 'react';

const ClickSpark = ({
  sparkColor = '#fff',
  sparkSize = 10,
  sparkRadius = 15,
  sparkCount = 8,
  duration = 400,
  easing = 'ease-out',
  extraScale = 1.0,
  children
}) => {
  const canvasRef = useRef(null);
  const sparksRef = useRef([]);
  const frameRef = useRef(0);

  // The canvas is position: fixed over the viewport, so it matches the
  // viewport -- never the (much taller) page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let t;
    const size = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    };
    const onResize = () => { clearTimeout(t); t = setTimeout(size, 100); };
    size();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, []);

  const easeFunc = useCallback(
    t => {
      switch (easing) {
        case 'linear':
          return t;
        case 'ease-in':
          return t * t;
        case 'ease-in-out':
          return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        default:
          return t * (2 - t);
      }
    },
    [easing]
  );

  const draw = useCallback((timestamp) => {
    const canvas = canvasRef.current;
    if (!canvas) { frameRef.current = 0; return; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    sparksRef.current = sparksRef.current.filter(spark => {
      const elapsed = timestamp - spark.startTime;
      if (elapsed >= duration) return false;
      const eased = easeFunc(Math.max(0, elapsed) / duration);
      const distance = eased * sparkRadius * extraScale;
      const lineLength = sparkSize * (1 - eased);
      const x1 = spark.x + distance * Math.cos(spark.angle);
      const y1 = spark.y + distance * Math.sin(spark.angle);
      const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle);
      const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle);
      ctx.strokeStyle = sparkColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      return true;
    });

    // Keep going only while something is still on screen.
    frameRef.current = sparksRef.current.length ? requestAnimationFrame(draw) : 0;
  }, [sparkColor, sparkSize, sparkRadius, duration, easeFunc, extraScale]);

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const handleClick = e => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const now = performance.now();
    for (let i = 0; i < sparkCount; i += 1) {
      sparksRef.current.push({ x, y, angle: (2 * Math.PI * i) / sparkCount, startTime: now });
    }
    if (!frameRef.current) frameRef.current = requestAnimationFrame(draw);
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%'
      }}
      onClickCapture={handleClick}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          userSelect: 'none',
          position: 'fixed',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          zIndex: 9999
        }}
      />
      {children}
    </div>
  );
};

export default ClickSpark;
