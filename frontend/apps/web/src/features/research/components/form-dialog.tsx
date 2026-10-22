'use client';

import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** A dialog with a form; `onSubmit` resolves true to close it. */
export function FormDialog({
  title,
  description,
  trigger,
  submitLabel = 'Save',
  pending,
  disabled,
  onSubmit,
  children,
  wide,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly trigger: ReactNode;
  readonly submitLabel?: string;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly onSubmit: () => Promise<boolean> | boolean;
  readonly children: ReactNode;
  readonly wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={cn(wide && 'sm:max-w-2xl')}>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onSubmit()) setOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3">{children}</div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || disabled}>
              {pending ? 'Saving…' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = 'text',
  required,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly hint?: ReactNode | undefined;
  readonly placeholder?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly className?: string | undefined;
}) {
  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
