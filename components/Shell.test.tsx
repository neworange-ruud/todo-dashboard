import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Shell from './Shell'

describe('Shell', () => {
  it('renders its children', () => {
    render(
      <Shell display="default">
        <p>today&apos;s content</p>
      </Shell>,
    )

    expect(screen.getByText("today's content")).toBeInTheDocument()
  })

  it('defaults to data-display="default"', () => {
    const { container } = render(
      <Shell display="default">
        <p>content</p>
      </Shell>,
    )

    expect(container.querySelector('.shell')).toHaveAttribute('data-display', 'default')
  })

  it('sets data-display="board" only when explicitly told to', () => {
    const { container } = render(
      <Shell display="board">
        <p>content</p>
      </Shell>,
    )

    expect(container.querySelector('.shell')).toHaveAttribute('data-display', 'board')
  })
})
