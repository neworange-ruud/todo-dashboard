import type { Metadata } from 'next'
import { ibmPlexMono, ibmPlexSans, newsreader } from '@/lib/fonts'
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
      <body>{children}</body>
    </html>
  )
}
