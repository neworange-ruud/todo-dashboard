import type { Metadata } from 'next'
import { ibmPlexMono, ibmPlexSans, newsreader } from '@/lib/fonts'
import { THEME_BOOT_SCRIPT } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'Task Desk',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}
    >
      <head>
        {/*
          Stamps the stored theme on <html> before the browser paints anything, so a reader
          who chose dark never sees a frame of light. It must be inline and it must be here:
          a deferred or bundled script runs after first paint, which is the flash itself.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
