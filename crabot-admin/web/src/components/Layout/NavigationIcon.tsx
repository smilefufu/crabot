const paths: Record<string, string> = {
  chat: 'M19 11a7 7 0 0 1-7 7H5l-3 3V11a9 9 0 0 1 18 0',
  tasks: 'M9 5h11M9 12h11M9 19h11M2 5l2 2 3-4M2 12l2 2 3-4M2 19l2 2 3-4',
  workspace: 'M3 7V4h7l3 3h8v13H3V7Zm0 3h18',
  memory: 'M5 3h15v18H5V3ZM2 7h5M2 12h5M2 17h5M10 8h6M10 13h6',
  abilities: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  social: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 21v-3a7 7 0 0 1 14 0v3M19 5a3 3 0 0 1 0 6M21 21v-4a5 5 0 0 0-2-4',
  settings: 'm9 3 1-2h4l1 2 3 2 2 1v4l-2 1v3l2 1v4l-2 1-3 2-1 2h-4l-1-2-3-2-2-1v-4l2-1v-3l-2-1V6l2-1 3-2Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
}

export function NavigationIcon({ name }: { name: string }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
