import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
const variants = cva('ui-button inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed', { variants: { variant: { default: 'button-primary', outline: 'button-outline', destructive: 'button-danger' } }, defaultVariants: { variant: 'default' } });
export function Button({ className, variant, ...props }: React.ComponentProps<'button'> & VariantProps<typeof variants>) { return <button className={twMerge(clsx(variants({ variant }), className))} {...props} />; }
