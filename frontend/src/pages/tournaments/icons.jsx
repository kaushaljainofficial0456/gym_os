/**
 * The tournament screens' icons: Lucide's drawings (ISC licence), in a table
 * of their own. Importing them from lucide-react made the build split every
 * icon shared with another page into its own tiny file, so opening Workout
 * meant fetching extra files for a feature nobody had opened. This table only
 * ever loads with Tournaments, the same reason Icon.jsx exists for the app.
 */
const icon = (nodes) => function TournamentIcon({ size = 24, strokeWidth = 2, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {nodes.map(([Tag, attrs], i) => <Tag key={i} {...attrs} />)}
    </svg>
  );
};

export const ArrowLeft = icon([["path",{"d":"m12 19-7-7 7-7"}],["path",{"d":"M19 12H5"}]]);
export const ArrowRight = icon([["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]]);
export const Award = icon([["path",{"d":"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"}],["circle",{"cx":"12","cy":"8","r":"6"}]]);
export const BarChart3 = icon([["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M18 17V9"}],["path",{"d":"M13 17V5"}],["path",{"d":"M8 17v-3"}]]);
export const BicepsFlexed = icon([["path",{"d":"M12.409 13.017A5 5 0 0 1 22 15c0 3.866-4 7-9 7-4.077 0-8.153-.82-10.371-2.462-.426-.316-.631-.832-.62-1.362C2.118 12.723 2.627 2 10 2a3 3 0 0 1 3 3 2 2 0 0 1-2 2c-1.105 0-1.64-.444-2-1"}],["path",{"d":"M15 14a5 5 0 0 0-7.584 2"}],["path",{"d":"M9.964 6.825C8.019 7.977 9.5 13 8 15"}]]);
export const Bike = icon([["circle",{"cx":"18.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"5.5","cy":"17.5","r":"3.5"}],["circle",{"cx":"15","cy":"5","r":"1"}],["path",{"d":"M12 17.5V14l-3-3 4-3 2 3h2"}]]);
export const Building2 = icon([["path",{"d":"M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"}],["path",{"d":"M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"}],["path",{"d":"M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"}],["path",{"d":"M10 6h4"}],["path",{"d":"M10 10h4"}],["path",{"d":"M10 14h4"}],["path",{"d":"M10 18h4"}]]);
export const Bus = icon([["path",{"d":"M8 6v6"}],["path",{"d":"M15 6v6"}],["path",{"d":"M2 12h19.6"}],["path",{"d":"M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"}],["circle",{"cx":"7","cy":"18","r":"2"}],["path",{"d":"M9 18h5"}],["circle",{"cx":"16","cy":"18","r":"2"}]]);
export const Calculator = icon([["rect",{"width":"16","height":"20","x":"4","y":"2","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"6","y2":"6"}],["line",{"x1":"16","x2":"16","y1":"14","y2":"18"}],["path",{"d":"M16 10h.01"}],["path",{"d":"M12 10h.01"}],["path",{"d":"M8 10h.01"}],["path",{"d":"M12 14h.01"}],["path",{"d":"M8 14h.01"}],["path",{"d":"M12 18h.01"}],["path",{"d":"M8 18h.01"}]]);
export const CalendarClock = icon([["path",{"d":"M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"}],["path",{"d":"M16 2v4"}],["path",{"d":"M8 2v4"}],["path",{"d":"M3 10h5"}],["path",{"d":"M17.5 17.5 16 16.3V14"}],["circle",{"cx":"16","cy":"16","r":"6"}]]);
export const CalendarDays = icon([["path",{"d":"M8 2v4"}],["path",{"d":"M16 2v4"}],["rect",{"width":"18","height":"18","x":"3","y":"4","rx":"2"}],["path",{"d":"M3 10h18"}],["path",{"d":"M8 14h.01"}],["path",{"d":"M12 14h.01"}],["path",{"d":"M16 14h.01"}],["path",{"d":"M8 18h.01"}],["path",{"d":"M12 18h.01"}],["path",{"d":"M16 18h.01"}]]);
export const CalendarPlus = icon([["path",{"d":"M8 2v4"}],["path",{"d":"M16 2v4"}],["path",{"d":"M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"}],["path",{"d":"M3 10h18"}],["path",{"d":"M16 19h6"}],["path",{"d":"M19 16v6"}]]);
export const Car = icon([["path",{"d":"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"}],["circle",{"cx":"7","cy":"17","r":"2"}],["path",{"d":"M9 17h6"}],["circle",{"cx":"17","cy":"17","r":"2"}]]);
export const Check = icon([["path",{"d":"M20 6 9 17l-5-5"}]]);
export const ChevronDown = icon([["path",{"d":"m6 9 6 6 6-6"}]]);
export const ChevronRight = icon([["path",{"d":"m9 18 6-6-6-6"}]]);
export const ClipboardList = icon([["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}],["path",{"d":"M12 11h4"}],["path",{"d":"M12 16h4"}],["path",{"d":"M8 11h.01"}],["path",{"d":"M8 16h.01"}]]);
export const CloudOff = icon([["path",{"d":"m2 2 20 20"}],["path",{"d":"M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"}],["path",{"d":"M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"}]]);
export const Compass = icon([["path",{"d":"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"}],["circle",{"cx":"12","cy":"12","r":"10"}]]);
export const Copy = icon([["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]]);
export const Crown = icon([["path",{"d":"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"}],["path",{"d":"M5 21h14"}]]);
export const DoorOpen = icon([["path",{"d":"M13 4h3a2 2 0 0 1 2 2v14"}],["path",{"d":"M2 20h3"}],["path",{"d":"M13 20h9"}],["path",{"d":"M10 12v.01"}],["path",{"d":"M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"}]]);
export const Download = icon([["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["polyline",{"points":"7 10 12 15 17 10"}],["line",{"x1":"12","x2":"12","y1":"15","y2":"3"}]]);
export const Dumbbell = icon([["path",{"d":"M14.4 14.4 9.6 9.6"}],["path",{"d":"M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"}],["path",{"d":"m21.5 21.5-1.4-1.4"}],["path",{"d":"M3.9 3.9 2.5 2.5"}],["path",{"d":"M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"}]]);
export const Film = icon([["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M7 3v18"}],["path",{"d":"M3 7.5h4"}],["path",{"d":"M3 12h18"}],["path",{"d":"M3 16.5h4"}],["path",{"d":"M17 3v18"}],["path",{"d":"M17 7.5h4"}],["path",{"d":"M17 16.5h4"}]]);
export const Flag = icon([["path",{"d":"M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"}],["line",{"x1":"4","x2":"4","y1":"22","y2":"15"}]]);
export const Flame = icon([["path",{"d":"M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"}]]);
export const Footprints = icon([["path",{"d":"M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"}],["path",{"d":"M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"}],["path",{"d":"M16 17h4"}],["path",{"d":"M4 13h4"}]]);
export const Gauge = icon([["path",{"d":"m12 14 4-4"}],["path",{"d":"M3.34 19a10 10 0 1 1 17.32 0"}]]);
export const Gift = icon([["rect",{"x":"3","y":"8","width":"18","height":"4","rx":"1"}],["path",{"d":"M12 8v13"}],["path",{"d":"M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"}],["path",{"d":"M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"}]]);
export const Globe = icon([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]]);
export const Hourglass = icon([["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]]);
export const Keyboard = icon([["path",{"d":"M10 8h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M14 8h.01"}],["path",{"d":"M16 12h.01"}],["path",{"d":"M18 8h.01"}],["path",{"d":"M6 8h.01"}],["path",{"d":"M7 16h10"}],["path",{"d":"M8 12h.01"}],["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}]]);
export const Layers = icon([["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]]);
export const Lock = icon([["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]]);
export const LogIn = icon([["path",{"d":"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"}],["polyline",{"points":"10 17 15 12 10 7"}],["line",{"x1":"15","x2":"3","y1":"12","y2":"12"}]]);
export const LogOut = icon([["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}],["polyline",{"points":"16 17 21 12 16 7"}],["line",{"x1":"21","x2":"9","y1":"12","y2":"12"}]]);
export const MapPin = icon([["path",{"d":"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"}],["circle",{"cx":"12","cy":"10","r":"3"}]]);
export const Medal = icon([["path",{"d":"M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"}],["path",{"d":"M11 12 5.12 2.2"}],["path",{"d":"m13 12 5.88-9.8"}],["path",{"d":"M8 7h8"}],["circle",{"cx":"12","cy":"17","r":"5"}],["path",{"d":"M12 18v-2h-.5"}]]);
export const Minus = icon([["path",{"d":"M5 12h14"}]]);
export const Monitor = icon([["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"21","y2":"21"}],["line",{"x1":"12","x2":"12","y1":"17","y2":"21"}]]);
export const Mountain = icon([["path",{"d":"m8 3 4 8 5-5 5 15H2L8 3z"}]]);
export const Music = icon([["path",{"d":"M9 18V5l12-2v13"}],["circle",{"cx":"6","cy":"18","r":"3"}],["circle",{"cx":"18","cy":"16","r":"3"}]]);
export const Palette = icon([["circle",{"cx":"13.5","cy":"6.5","r":".5","fill":"currentColor"}],["circle",{"cx":"17.5","cy":"10.5","r":".5","fill":"currentColor"}],["circle",{"cx":"8.5","cy":"7.5","r":".5","fill":"currentColor"}],["circle",{"cx":"6.5","cy":"12.5","r":".5","fill":"currentColor"}],["path",{"d":"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"}]]);
export const Pause = icon([["rect",{"x":"14","y":"4","width":"4","height":"16","rx":"1"}],["rect",{"x":"6","y":"4","width":"4","height":"16","rx":"1"}]]);
export const Pencil = icon([["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"m15 5 4 4"}]]);
export const Piano = icon([["path",{"d":"M18.5 8c-1.4 0-2.6-.8-3.2-2A6.87 6.87 0 0 0 2 9v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8.5C22 9.6 20.4 8 18.5 8"}],["path",{"d":"M2 14h20"}],["path",{"d":"M6 14v4"}],["path",{"d":"M10 14v4"}],["path",{"d":"M14 14v4"}],["path",{"d":"M18 14v4"}]]);
export const Play = icon([["polygon",{"points":"6 3 20 12 6 21 6 3"}]]);
export const Plus = icon([["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]]);
export const QrCode = icon([["rect",{"width":"5","height":"5","x":"3","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"16","y":"3","rx":"1"}],["rect",{"width":"5","height":"5","x":"3","y":"16","rx":"1"}],["path",{"d":"M21 16h-3a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 21v.01"}],["path",{"d":"M12 7v3a2 2 0 0 1-2 2H7"}],["path",{"d":"M3 12h.01"}],["path",{"d":"M12 3h.01"}],["path",{"d":"M12 16v.01"}],["path",{"d":"M16 12h1"}],["path",{"d":"M21 12v.01"}],["path",{"d":"M12 21v-1"}]]);
export const Radio = icon([["path",{"d":"M4.9 19.1C1 15.2 1 8.8 4.9 4.9"}],["path",{"d":"M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"}],["circle",{"cx":"12","cy":"12","r":"2"}],["path",{"d":"M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"}],["path",{"d":"M19.1 4.9C23 8.8 23 15.1 19.1 19"}]]);
export const RefreshCw = icon([["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]]);
export const Repeat = icon([["path",{"d":"m17 2 4 4-4 4"}],["path",{"d":"M3 11v-1a4 4 0 0 1 4-4h14"}],["path",{"d":"m7 22-4-4 4-4"}],["path",{"d":"M21 13v1a4 4 0 0 1-4 4H3"}]]);
export const Rocket = icon([["path",{"d":"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"}],["path",{"d":"m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"}],["path",{"d":"M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"}],["path",{"d":"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"}]]);
export const RotateCcw = icon([["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]]);
export const Ruler = icon([["path",{"d":"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"}],["path",{"d":"m14.5 12.5 2-2"}],["path",{"d":"m11.5 9.5 2-2"}],["path",{"d":"m8.5 6.5 2-2"}],["path",{"d":"m17.5 15.5 2-2"}]]);
export const Scale = icon([["path",{"d":"m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"}],["path",{"d":"m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"}],["path",{"d":"M7 21h10"}],["path",{"d":"M12 3v18"}],["path",{"d":"M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"}]]);
export const ScanLine = icon([["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M7 12h10"}]]);
export const Search = icon([["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]]);
export const Settings2 = icon([["path",{"d":"M20 7h-9"}],["path",{"d":"M14 17H5"}],["circle",{"cx":"17","cy":"17","r":"3"}],["circle",{"cx":"7","cy":"7","r":"3"}]]);
export const Share2 = icon([["circle",{"cx":"18","cy":"5","r":"3"}],["circle",{"cx":"6","cy":"12","r":"3"}],["circle",{"cx":"18","cy":"19","r":"3"}],["line",{"x1":"8.59","x2":"15.42","y1":"13.51","y2":"17.49"}],["line",{"x1":"15.41","x2":"8.59","y1":"6.51","y2":"10.49"}]]);
export const ShieldCheck = icon([["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]]);
export const Skull = icon([["path",{"d":"m12.5 17-.5-1-.5 1h1z"}],["path",{"d":"M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"}],["circle",{"cx":"15","cy":"12","r":"1"}],["circle",{"cx":"9","cy":"12","r":"1"}]]);
export const Smile = icon([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M8 14s1.5 2 4 2 4-2 4-2"}],["line",{"x1":"9","x2":"9.01","y1":"9","y2":"9"}],["line",{"x1":"15","x2":"15.01","y1":"9","y2":"9"}]]);
export const Sparkles = icon([["path",{"d":"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"}],["path",{"d":"M20 3v4"}],["path",{"d":"M22 5h-4"}],["path",{"d":"M4 17v2"}],["path",{"d":"M5 18H3"}]]);
export const Swords = icon([["polyline",{"points":"14.5 17.5 3 6 3 3 6 3 17.5 14.5"}],["line",{"x1":"13","x2":"19","y1":"19","y2":"13"}],["line",{"x1":"16","x2":"20","y1":"16","y2":"20"}],["line",{"x1":"19","x2":"21","y1":"21","y2":"19"}],["polyline",{"points":"14.5 6.5 18 3 21 3 21 6 17.5 9.5"}],["line",{"x1":"5","x2":"9","y1":"14","y2":"18"}],["line",{"x1":"7","x2":"4","y1":"17","y2":"20"}],["line",{"x1":"3","x2":"5","y1":"19","y2":"21"}]]);
export const Target = icon([["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"12","r":"6"}],["circle",{"cx":"12","cy":"12","r":"2"}]]);
export const Timer = icon([["line",{"x1":"10","x2":"14","y1":"2","y2":"2"}],["line",{"x1":"12","x2":"15","y1":"14","y2":"11"}],["circle",{"cx":"12","cy":"14","r":"8"}]]);
export const Trash2 = icon([["path",{"d":"M3 6h18"}],["path",{"d":"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"}],["path",{"d":"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"}],["line",{"x1":"10","x2":"10","y1":"11","y2":"17"}],["line",{"x1":"14","x2":"14","y1":"11","y2":"17"}]]);
export const TrendingUp = icon([["polyline",{"points":"22 7 13.5 15.5 8.5 10.5 2 17"}],["polyline",{"points":"16 7 22 7 22 13"}]]);
export const Trophy = icon([["path",{"d":"M6 9H4.5a2.5 2.5 0 0 1 0-5H6"}],["path",{"d":"M18 9h1.5a2.5 2.5 0 0 0 0-5H18"}],["path",{"d":"M4 22h16"}],["path",{"d":"M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"}],["path",{"d":"M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"}],["path",{"d":"M18 2H6v7a6 6 0 0 0 12 0V2Z"}]]);
export const Undo2 = icon([["path",{"d":"M9 14 4 9l5-5"}],["path",{"d":"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"}]]);
export const Unlock = icon([["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 9.9-1"}]]);
export const UserPlus = icon([["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["line",{"x1":"19","x2":"19","y1":"8","y2":"14"}],["line",{"x1":"22","x2":"16","y1":"11","y2":"11"}]]);
export const UserRound = icon([["circle",{"cx":"12","cy":"8","r":"5"}],["path",{"d":"M20 21a8 8 0 0 0-16 0"}]]);
export const Users = icon([["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["path",{"d":"M16 3.13a4 4 0 0 1 0 7.75"}]]);
export const Weight = icon([["circle",{"cx":"12","cy":"5","r":"3"}],["path",{"d":"M6.5 8a2 2 0 0 0-1.905 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.925-2.54L19.4 9.5A2 2 0 0 0 17.48 8Z"}]]);
export const X = icon([["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]]);
export const Zap = icon([["path",{"d":"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"}]]);
