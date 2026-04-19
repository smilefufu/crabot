import React from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  help?: string
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  help,
  className = '',
  id,
  ...props
}) => {
  const generatedId = React.useId()
  const inputId = id ?? generatedId

  return (
    <div className="form-group">
      {label && <label className="form-label" htmlFor={inputId}>{label}</label>}
      <input id={inputId} className={`input ${className}`} {...props} />
      {help && <span className="form-help">{help}</span>}
      {error && <span className="form-help" style={{ color: 'var(--error)' }}>{error}</span>}
    </div>
  )
}
