-- One-time cleanup matching stripDeviceTag() in src/routes/kosync.ts: drop the single optimized
-- copy tag "(x)" from stored titles and filenames (9002 covered the legacy "(X3)"/"(X4)").

-- Leading "(x) ".
UPDATE documents SET title = substr(title, 5)
  WHERE lower(substr(title, 1, 4)) = '(x) ' AND length(title) > 4;
UPDATE documents SET filename = substr(filename, 5)
  WHERE lower(substr(filename, 1, 4)) = '(x) ' AND length(filename) > 4;

-- Trailing " (x)" on a title.
UPDATE documents SET title = substr(title, 1, length(title) - 4)
  WHERE lower(substr(title, -4)) = ' (x)' AND length(title) > 4;

-- Trailing " (x)" before a filename extension of 2 to 5 characters (tail = 5 + extension).
UPDATE documents SET filename = substr(filename, 1, length(filename) - 10) || substr(filename, -6)
  WHERE lower(substr(filename, -10, 5)) = ' (x).' AND length(filename) > 10;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 9) || substr(filename, -5)
  WHERE lower(substr(filename, -9, 5)) = ' (x).' AND length(filename) > 9;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 8) || substr(filename, -4)
  WHERE lower(substr(filename, -8, 5)) = ' (x).' AND length(filename) > 8;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 7) || substr(filename, -3)
  WHERE lower(substr(filename, -7, 5)) = ' (x).' AND length(filename) > 7;

-- "Author - (x) Title".
UPDATE documents SET
  title = replace(replace(title, ' - (x) ', ' - '), ' - (X) ', ' - '),
  filename = replace(replace(filename, ' - (x) ', ' - '), ' - (X) ', ' - ');
