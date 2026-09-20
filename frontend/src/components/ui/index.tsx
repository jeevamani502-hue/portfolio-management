/**
 * Minimal UI primitives in the shadcn/ui idiom.
 *
 * Hand-written rather than generated, so the project carries no Radix
 * dependency for components that do not need one. The APIs match shadcn's
 * closely enough that swapping in the generated components later is a
 * drop-in change.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// ── Button ──────────────────────────────────────────────────────────────────

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none ' +
    'disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

// ── Card ────────────────────────────────────────────────────────────────────

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1 p-4 pb-3', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />
);

export const CardDescription = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-xs text-muted-foreground', className)} {...props} />
);

export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 pt-0', className)} {...props} />
);

export const CardFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center p-4 pt-0', className)} {...props} />
);

// ── Input / Label / Select ──────────────────────────────────────────────────

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
        'transition-colors placeholder:text-muted-foreground focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Label = ({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label
    className={cn('text-xs font-medium leading-none text-muted-foreground', className)}
    {...props}
  />
);

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

// ── Badge ───────────────────────────────────────────────────────────────────

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/15 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        up: 'border-transparent bg-up/15 text-up',
        down: 'border-transparent bg-down/15 text-down',
        warning: 'border-transparent bg-delayed/15 text-delayed',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);

// ── Skeleton / Spinner ──────────────────────────────────────────────────────

export const Skeleton = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
);

export const Spinner = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="Loading"
    className={cn(
      'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent',
      className,
    )}
  />
);

// ── Tabs ────────────────────────────────────────────────────────────────────

interface TabsProps {
  tabs: Array<{ id: string; label: string; badge?: string | number }>;
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs = ({ tabs, active, onChange, className }: TabsProps) => (
  <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}>
    {tabs.map((t) => (
      <button
        key={t.id}
        role="tab"
        aria-selected={active === t.id}
        onClick={() => onChange(t.id)}
        className={cn(
          'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
          active === t.id
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        {t.label}
        {t.badge !== undefined && (
          <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {t.badge}
          </span>
        )}
      </button>
    ))}
  </div>
);

// ── Alert ───────────────────────────────────────────────────────────────────

export const Alert = ({
  variant = 'default',
  title,
  children,
  className,
}: {
  variant?: 'default' | 'warning' | 'error' | 'info';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) => (
  <div
    role="note"
    className={cn(
      'rounded-md border px-3 py-2 text-xs',
      variant === 'warning' && 'border-delayed/40 bg-delayed/10 text-foreground',
      variant === 'error' && 'border-destructive/40 bg-destructive/10 text-foreground',
      variant === 'info' && 'border-primary/30 bg-primary/10 text-foreground',
      variant === 'default' && 'border-border bg-muted/40 text-muted-foreground',
      className,
    )}
  >
    {title && <div className="mb-0.5 font-semibold text-foreground">{title}</div>}
    {children}
  </div>
);

// ── Tooltip (CSS-only, no dependency) ───────────────────────────────────────

export const Tooltip = ({
  content,
  children,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <span className={cn('group/tt relative inline-flex', className)}>
    {children}
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-max
                 max-w-xs -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1.5
                 text-2xs font-normal leading-relaxed text-card-foreground shadow-lg
                 group-hover/tt:block group-focus-within/tt:block"
    >
      {content}
    </span>
  </span>
);

// ── Empty state ─────────────────────────────────────────────────────────────

export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
    {icon && <div className="text-muted-foreground/60">{icon}</div>}
    <div className="text-sm font-medium">{title}</div>
    {description && (
      <div className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</div>
    )}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
