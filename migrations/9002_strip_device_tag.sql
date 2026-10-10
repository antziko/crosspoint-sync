-- One-time cleanup matching stripDeviceTag() in src/routes/kosync.ts: drop the "(X3)"/"(X4)"
-- copy tag from stored titles and filenames so every copy of a book shows one name.

-- Leading "(Xn) ".
UPDATE documents SET title = substr(title, 6)
  WHERE lower(substr(title, 1, 5)) IN ('(x3) ', '(x4) ') AND length(title) > 5;
UPDATE documents SET filename = substr(filename, 6)
  WHERE lower(substr(filename, 1, 5)) IN ('(x3) ', '(x4) ') AND length(filename) > 5;

-- Trailing " (Xn)" on a title.
UPDATE documents SET title = substr(title, 1, length(title) - 5)
  WHERE lower(substr(title, -5)) IN (' (x3)', ' (x4)') AND length(title) > 5;

-- Trailing " (Xn)" before a filename extension of 2 to 5 characters (tail = 6 + extension).
UPDATE documents SET filename = substr(filename, 1, length(filename) - 11) || substr(filename, -6)
  WHERE lower(substr(filename, -11, 6)) IN (' (x3).', ' (x4).') AND length(filename) > 11;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 10) || substr(filename, -5)
  WHERE lower(substr(filename, -10, 6)) IN (' (x3).', ' (x4).') AND length(filename) > 10;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 9) || substr(filename, -4)
  WHERE lower(substr(filename, -9, 6)) IN (' (x3).', ' (x4).') AND length(filename) > 9;
UPDATE documents SET filename = substr(filename, 1, length(filename) - 8) || substr(filename, -3)
  WHERE lower(substr(filename, -8, 6)) IN (' (x3).', ' (x4).') AND length(filename) > 8;

-- "Author - (Xn) Title".
UPDATE documents SET
  title = replace(replace(replace(replace(title, ' - (X3) ', ' - '), ' - (X4) ', ' - '), ' - (x3) ', ' - '), ' - (x4) ', ' - '),
  filename = replace(replace(replace(replace(filename, ' - (X3) ', ' - '), ' - (X4) ', ' - '), ' - (x3) ', ' - '), ' - (x4) ', ' - ');
