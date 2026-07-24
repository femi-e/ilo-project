#pragma once
#include "lbug/include/lbug_rs.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace rust {
inline namespace cxxbridge1 {
// #include "rust/cxx.h"

#ifndef CXXBRIDGE1_PANIC
#define CXXBRIDGE1_PANIC
template <typename Exception>
void panic [[noreturn]] (const char *msg);
#endif // CXXBRIDGE1_PANIC

struct unsafe_bitcopy_t;

namespace {
template <typename T>
class impl;
} // namespace

class Opaque;

template <typename T>
::std::size_t size_of();
template <typename T>
::std::size_t align_of();

#ifndef CXXBRIDGE1_RUST_STRING
#define CXXBRIDGE1_RUST_STRING
class String final {
public:
  String() noexcept;
  String(const String &) noexcept;
  String(String &&) noexcept;
  ~String() noexcept;

  String(const std::string &);
  String(const char *);
  String(const char *, std::size_t);
  String(const char16_t *);
  String(const char16_t *, std::size_t);

  static String lossy(const std::string &) noexcept;
  static String lossy(const char *) noexcept;
  static String lossy(const char *, std::size_t) noexcept;
  static String lossy(const char16_t *) noexcept;
  static String lossy(const char16_t *, std::size_t) noexcept;

  String &operator=(const String &) &noexcept;
  String &operator=(String &&) &noexcept;

  explicit operator std::string() const;

  const char *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  const char *c_str() noexcept;

  std::size_t capacity() const noexcept;
  void reserve(size_t new_cap) noexcept;

  using iterator = char *;
  iterator begin() noexcept;
  iterator end() noexcept;

  using const_iterator = const char *;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  bool operator==(const String &) const noexcept;
  bool operator!=(const String &) const noexcept;
  bool operator<(const String &) const noexcept;
  bool operator<=(const String &) const noexcept;
  bool operator>(const String &) const noexcept;
  bool operator>=(const String &) const noexcept;

  void swap(String &) noexcept;

  String(unsafe_bitcopy_t, const String &) noexcept;

private:
  struct lossy_t;
  String(lossy_t, const char *, std::size_t) noexcept;
  String(lossy_t, const char16_t *, std::size_t) noexcept;
  friend void swap(String &lhs, String &rhs) noexcept { lhs.swap(rhs); }

  std::array<std::uintptr_t, 3> repr;
};
#endif // CXXBRIDGE1_RUST_STRING

#ifndef CXXBRIDGE1_RUST_STR
#define CXXBRIDGE1_RUST_STR
class Str final {
public:
  Str() noexcept;
  Str(const String &) noexcept;
  Str(const std::string &);
  Str(const char *);
  Str(const char *, std::size_t);

  Str &operator=(const Str &) &noexcept = default;

  explicit operator std::string() const;

  const char *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  Str(const Str &) noexcept = default;
  ~Str() noexcept = default;

  using iterator = const char *;
  using const_iterator = const char *;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  bool operator==(const Str &) const noexcept;
  bool operator!=(const Str &) const noexcept;
  bool operator<(const Str &) const noexcept;
  bool operator<=(const Str &) const noexcept;
  bool operator>(const Str &) const noexcept;
  bool operator>=(const Str &) const noexcept;

  void swap(Str &) noexcept;

private:
  class uninit;
  Str(uninit) noexcept;
  friend impl<Str>;

  std::array<std::uintptr_t, 2> repr;
};
#endif // CXXBRIDGE1_RUST_STR

#ifndef CXXBRIDGE1_RUST_SLICE
#define CXXBRIDGE1_RUST_SLICE
namespace detail {
template <bool>
struct copy_assignable_if {};

template <>
struct copy_assignable_if<false> {
  copy_assignable_if() noexcept = default;
  copy_assignable_if(const copy_assignable_if &) noexcept = default;
  copy_assignable_if &operator=(const copy_assignable_if &) &noexcept = delete;
  copy_assignable_if &operator=(copy_assignable_if &&) &noexcept = default;
};
} // namespace detail

template <typename T>
class Slice final
    : private detail::copy_assignable_if<std::is_const<T>::value> {
public:
  using value_type = T;

  Slice() noexcept;
  Slice(T *, std::size_t count) noexcept;

  template <typename C>
  explicit Slice(C& c) : Slice(c.data(), c.size()) {}

  Slice &operator=(const Slice<T> &) &noexcept = default;
  Slice &operator=(Slice<T> &&) &noexcept = default;

  T *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  T &operator[](std::size_t n) const noexcept;
  T &at(std::size_t n) const;
  T &front() const noexcept;
  T &back() const noexcept;

  Slice(const Slice<T> &) noexcept = default;
  ~Slice() noexcept = default;

  class iterator;
  iterator begin() const noexcept;
  iterator end() const noexcept;

  void swap(Slice &) noexcept;

private:
  class uninit;
  Slice(uninit) noexcept;
  friend impl<Slice>;
  friend void sliceInit(void *, const void *, std::size_t) noexcept;
  friend void *slicePtr(const void *) noexcept;
  friend std::size_t sliceLen(const void *) noexcept;

  std::array<std::uintptr_t, 2> repr;
};

template <typename T>
class Slice<T>::iterator final {
public:
  using iterator_category = std::random_access_iterator_tag;
  using value_type = T;
  using difference_type = std::ptrdiff_t;
  using pointer = typename std::add_pointer<T>::type;
  using reference = typename std::add_lvalue_reference<T>::type;

  reference operator*() const noexcept;
  pointer operator->() const noexcept;
  reference operator[](difference_type) const noexcept;

  iterator &operator++() noexcept;
  iterator operator++(int) noexcept;
  iterator &operator--() noexcept;
  iterator operator--(int) noexcept;

  iterator &operator+=(difference_type) noexcept;
  iterator &operator-=(difference_type) noexcept;
  iterator operator+(difference_type) const noexcept;
  iterator operator-(difference_type) const noexcept;
  difference_type operator-(const iterator &) const noexcept;

  bool operator==(const iterator &) const noexcept;
  bool operator!=(const iterator &) const noexcept;
  bool operator<(const iterator &) const noexcept;
  bool operator<=(const iterator &) const noexcept;
  bool operator>(const iterator &) const noexcept;
  bool operator>=(const iterator &) const noexcept;

private:
  friend class Slice;
  void *pos;
  std::size_t stride;
};

template <typename T>
Slice<T>::Slice() noexcept {
  sliceInit(this, reinterpret_cast<void *>(align_of<T>()), 0);
}

template <typename T>
Slice<T>::Slice(T *s, std::size_t count) noexcept {
  assert(s != nullptr || count == 0);
  sliceInit(this,
            s == nullptr && count == 0
                ? reinterpret_cast<void *>(align_of<T>())
                : const_cast<typename std::remove_const<T>::type *>(s),
            count);
}

template <typename T>
T *Slice<T>::data() const noexcept {
  return reinterpret_cast<T *>(slicePtr(this));
}

template <typename T>
std::size_t Slice<T>::size() const noexcept {
  return sliceLen(this);
}

template <typename T>
std::size_t Slice<T>::length() const noexcept {
  return this->size();
}

template <typename T>
bool Slice<T>::empty() const noexcept {
  return this->size() == 0;
}

template <typename T>
T &Slice<T>::operator[](std::size_t n) const noexcept {
  assert(n < this->size());
  auto ptr = static_cast<char *>(slicePtr(this)) + size_of<T>() * n;
  return *reinterpret_cast<T *>(ptr);
}

template <typename T>
T &Slice<T>::at(std::size_t n) const {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Slice index out of range");
  }
  return (*this)[n];
}

template <typename T>
T &Slice<T>::front() const noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
T &Slice<T>::back() const noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
typename Slice<T>::iterator::reference
Slice<T>::iterator::operator*() const noexcept {
  return *static_cast<T *>(this->pos);
}

template <typename T>
typename Slice<T>::iterator::pointer
Slice<T>::iterator::operator->() const noexcept {
  return static_cast<T *>(this->pos);
}

template <typename T>
typename Slice<T>::iterator::reference Slice<T>::iterator::operator[](
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ptr = static_cast<char *>(this->pos) + this->stride * n;
  return *reinterpret_cast<T *>(ptr);
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator++() noexcept {
  this->pos = static_cast<char *>(this->pos) + this->stride;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator++(int) noexcept {
  auto ret = iterator(*this);
  this->pos = static_cast<char *>(this->pos) + this->stride;
  return ret;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator--() noexcept {
  this->pos = static_cast<char *>(this->pos) - this->stride;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator--(int) noexcept {
  auto ret = iterator(*this);
  this->pos = static_cast<char *>(this->pos) - this->stride;
  return ret;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator+=(
    typename Slice<T>::iterator::difference_type n) noexcept {
  this->pos = static_cast<char *>(this->pos) + this->stride * n;
  return *this;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator-=(
    typename Slice<T>::iterator::difference_type n) noexcept {
  this->pos = static_cast<char *>(this->pos) - this->stride * n;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator+(
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ret = iterator(*this);
  ret.pos = static_cast<char *>(this->pos) + this->stride * n;
  return ret;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator-(
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ret = iterator(*this);
  ret.pos = static_cast<char *>(this->pos) - this->stride * n;
  return ret;
}

template <typename T>
typename Slice<T>::iterator::difference_type
Slice<T>::iterator::operator-(const iterator &other) const noexcept {
  auto diff = std::distance(static_cast<char *>(other.pos),
                            static_cast<char *>(this->pos));
  return diff / static_cast<typename Slice<T>::iterator::difference_type>(
                    this->stride);
}

template <typename T>
bool Slice<T>::iterator::operator==(const iterator &other) const noexcept {
  return this->pos == other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator!=(const iterator &other) const noexcept {
  return this->pos != other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator<(const iterator &other) const noexcept {
  return this->pos < other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator<=(const iterator &other) const noexcept {
  return this->pos <= other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator>(const iterator &other) const noexcept {
  return this->pos > other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator>=(const iterator &other) const noexcept {
  return this->pos >= other.pos;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::begin() const noexcept {
  iterator it;
  it.pos = slicePtr(this);
  it.stride = size_of<T>();
  return it;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::end() const noexcept {
  iterator it = this->begin();
  it.pos = static_cast<char *>(it.pos) + it.stride * this->size();
  return it;
}

template <typename T>
void Slice<T>::swap(Slice &rhs) noexcept {
  std::swap(*this, rhs);
}
#endif // CXXBRIDGE1_RUST_SLICE

#ifndef CXXBRIDGE1_RUST_BITCOPY_T
#define CXXBRIDGE1_RUST_BITCOPY_T
struct unsafe_bitcopy_t final {
  explicit unsafe_bitcopy_t() = default;
};
#endif // CXXBRIDGE1_RUST_BITCOPY_T

#ifndef CXXBRIDGE1_RUST_VEC
#define CXXBRIDGE1_RUST_VEC
template <typename T>
class Vec final {
public:
  using value_type = T;

  Vec() noexcept;
  Vec(std::initializer_list<T>);
  Vec(const Vec &);
  Vec(Vec &&) noexcept;
  ~Vec() noexcept;

  Vec &operator=(Vec &&) &noexcept;
  Vec &operator=(const Vec &) &;

  std::size_t size() const noexcept;
  bool empty() const noexcept;
  const T *data() const noexcept;
  T *data() noexcept;
  std::size_t capacity() const noexcept;

  const T &operator[](std::size_t n) const noexcept;
  const T &at(std::size_t n) const;
  const T &front() const noexcept;
  const T &back() const noexcept;

  T &operator[](std::size_t n) noexcept;
  T &at(std::size_t n);
  T &front() noexcept;
  T &back() noexcept;

  void reserve(std::size_t new_cap);
  void push_back(const T &value);
  void push_back(T &&value);
  template <typename... Args>
  void emplace_back(Args &&...args);
  void truncate(std::size_t len);
  void clear();

  using iterator = typename Slice<T>::iterator;
  iterator begin() noexcept;
  iterator end() noexcept;

  using const_iterator = typename Slice<const T>::iterator;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  void swap(Vec &) noexcept;

  Vec(unsafe_bitcopy_t, const Vec &) noexcept;

private:
  void reserve_total(std::size_t new_cap) noexcept;
  void set_len(std::size_t len) noexcept;
  void drop() noexcept;

  friend void swap(Vec &lhs, Vec &rhs) noexcept { lhs.swap(rhs); }

  std::array<std::uintptr_t, 3> repr;
};

template <typename T>
Vec<T>::Vec(std::initializer_list<T> init) : Vec{} {
  this->reserve_total(init.size());
  std::move(init.begin(), init.end(), std::back_inserter(*this));
}

template <typename T>
Vec<T>::Vec(const Vec &other) : Vec() {
  this->reserve_total(other.size());
  std::copy(other.begin(), other.end(), std::back_inserter(*this));
}

template <typename T>
Vec<T>::Vec(Vec &&other) noexcept : repr(other.repr) {
  new (&other) Vec();
}

template <typename T>
Vec<T>::~Vec() noexcept {
  this->drop();
}

template <typename T>
Vec<T> &Vec<T>::operator=(Vec &&other) &noexcept {
  this->drop();
  this->repr = other.repr;
  new (&other) Vec();
  return *this;
}

template <typename T>
Vec<T> &Vec<T>::operator=(const Vec &other) & {
  if (this != &other) {
    this->drop();
    new (this) Vec(other);
  }
  return *this;
}

template <typename T>
bool Vec<T>::empty() const noexcept {
  return this->size() == 0;
}

template <typename T>
T *Vec<T>::data() noexcept {
  return const_cast<T *>(const_cast<const Vec<T> *>(this)->data());
}

template <typename T>
const T &Vec<T>::operator[](std::size_t n) const noexcept {
  assert(n < this->size());
  auto data = reinterpret_cast<const char *>(this->data());
  return *reinterpret_cast<const T *>(data + n * size_of<T>());
}

template <typename T>
const T &Vec<T>::at(std::size_t n) const {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Vec index out of range");
  }
  return (*this)[n];
}

template <typename T>
const T &Vec<T>::front() const noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
const T &Vec<T>::back() const noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
T &Vec<T>::operator[](std::size_t n) noexcept {
  assert(n < this->size());
  auto data = reinterpret_cast<char *>(this->data());
  return *reinterpret_cast<T *>(data + n * size_of<T>());
}

template <typename T>
T &Vec<T>::at(std::size_t n) {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Vec index out of range");
  }
  return (*this)[n];
}

template <typename T>
T &Vec<T>::front() noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
T &Vec<T>::back() noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
void Vec<T>::reserve(std::size_t new_cap) {
  this->reserve_total(new_cap);
}

template <typename T>
void Vec<T>::push_back(const T &value) {
  this->emplace_back(value);
}

template <typename T>
void Vec<T>::push_back(T &&value) {
  this->emplace_back(std::move(value));
}

template <typename T>
template <typename... Args>
void Vec<T>::emplace_back(Args &&...args) {
  auto size = this->size();
  this->reserve_total(size + 1);
  ::new (reinterpret_cast<T *>(reinterpret_cast<char *>(this->data()) +
                               size * size_of<T>()))
      T(std::forward<Args>(args)...);
  this->set_len(size + 1);
}

template <typename T>
void Vec<T>::clear() {
  this->truncate(0);
}

template <typename T>
typename Vec<T>::iterator Vec<T>::begin() noexcept {
  return Slice<T>(this->data(), this->size()).begin();
}

template <typename T>
typename Vec<T>::iterator Vec<T>::end() noexcept {
  return Slice<T>(this->data(), this->size()).end();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::begin() const noexcept {
  return this->cbegin();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::end() const noexcept {
  return this->cend();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::cbegin() const noexcept {
  return Slice<const T>(this->data(), this->size()).begin();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::cend() const noexcept {
  return Slice<const T>(this->data(), this->size()).end();
}

template <typename T>
void Vec<T>::swap(Vec &rhs) noexcept {
  using std::swap;
  swap(this->repr, rhs.repr);
}

template <typename T>
Vec<T>::Vec(unsafe_bitcopy_t, const Vec &bits) noexcept : repr(bits.repr) {}
#endif // CXXBRIDGE1_RUST_VEC

#ifndef CXXBRIDGE1_IS_COMPLETE
#define CXXBRIDGE1_IS_COMPLETE
namespace detail {
namespace {
template <typename T, typename = std::size_t>
struct is_complete : std::false_type {};
template <typename T>
struct is_complete<T, decltype(sizeof(T))> : std::true_type {};
} // namespace
} // namespace detail
#endif // CXXBRIDGE1_IS_COMPLETE

#ifndef CXXBRIDGE1_LAYOUT
#define CXXBRIDGE1_LAYOUT
class layout {
  template <typename T>
  friend std::size_t size_of();
  template <typename T>
  friend std::size_t align_of();
  template <typename T>
  static typename std::enable_if<std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_size_of() {
    return T::layout::size();
  }
  template <typename T>
  static typename std::enable_if<!std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_size_of() {
    return sizeof(T);
  }
  template <typename T>
  static
      typename std::enable_if<detail::is_complete<T>::value, std::size_t>::type
      size_of() {
    return do_size_of<T>();
  }
  template <typename T>
  static typename std::enable_if<std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_align_of() {
    return T::layout::align();
  }
  template <typename T>
  static typename std::enable_if<!std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_align_of() {
    return alignof(T);
  }
  template <typename T>
  static
      typename std::enable_if<detail::is_complete<T>::value, std::size_t>::type
      align_of() {
    return do_align_of<T>();
  }
};

template <typename T>
std::size_t size_of() {
  return layout::size_of<T>();
}

template <typename T>
std::size_t align_of() {
  return layout::align_of<T>();
}
#endif // CXXBRIDGE1_LAYOUT
} // namespace cxxbridge1
} // namespace rust

namespace lbug {
  namespace common {
    using LogicalTypeID = ::lbug::common::LogicalTypeID;
    using PhysicalTypeID = ::lbug::common::PhysicalTypeID;
    using StatementType = ::lbug::common::StatementType;
    using LogicalType = ::lbug::common::LogicalType;
    using Value = ::lbug::common::Value;
  }
  namespace main {
    using PreparedStatement = ::lbug::main::PreparedStatement;
    using Database = ::lbug::main::Database;
    using Connection = ::lbug::main::Connection;
    using QueryResult = ::lbug::main::QueryResult;
  }
  namespace processor {
    using FlatTuple = ::lbug::processor::FlatTuple;
  }
}
namespace lbug_rs {
  using QueryParams = ::lbug_rs::QueryParams;
  using ValueListBuilder = ::lbug_rs::ValueListBuilder;
  using TypeListBuilder = ::lbug_rs::TypeListBuilder;
}

namespace lbug {
namespace common {
static_assert(::std::is_enum<LogicalTypeID>::value, "expected enum");
static_assert(sizeof(LogicalTypeID) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::ANY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::NODE) == 10, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::REL) == 11, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::RECURSIVE_REL) == 12, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::SERIAL) == 13, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::BOOL) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT64) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT32) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT16) == 25, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT8) == 26, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT64) == 27, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT32) == 28, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT16) == 29, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT8) == 30, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT128) == 31, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DOUBLE) == 32, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::FLOAT) == 33, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DATE) == 34, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP) == 35, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_SEC) == 36, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_MS) == 37, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_NS) == 38, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_TZ) == 39, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INTERVAL) == 40, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DECIMAL) == 41, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INTERNAL_ID) == 42, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::STRING) == 50, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::BLOB) == 51, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::LIST) == 52, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::ARRAY) == 53, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::STRUCT) == 54, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::MAP) == 55, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UNION) == 56, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UUID) == 59, "disagrees with the value in #[cxx::bridge]");

static_assert(::std::is_enum<PhysicalTypeID>::value, "expected enum");
static_assert(sizeof(PhysicalTypeID) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::ANY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::BOOL) == 1, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT64) == 2, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT32) == 3, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT16) == 4, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT8) == 5, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT64) == 6, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT32) == 7, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT16) == 8, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT8) == 9, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT128) == 10, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::DOUBLE) == 11, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::FLOAT) == 12, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INTERVAL) == 13, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INTERNAL_ID) == 14, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::STRING) == 20, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::LIST) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::ARRAY) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::STRUCT) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::POINTER) == 25, "disagrees with the value in #[cxx::bridge]");

static_assert(::std::is_enum<StatementType>::value, "expected enum");
static_assert(sizeof(StatementType) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(StatementType::QUERY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_TABLE) == 1, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::DROP) == 2, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::ALTER) == 3, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::COPY_TO) == 19, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::COPY_FROM) == 20, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::STANDALONE_CALL) == 21, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::STANDALONE_CALL_FUNCTION) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXPLAIN) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_MACRO) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::TRANSACTION) == 30, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXTENSION) == 31, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXPORT_DATABASE) == 32, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::IMPORT_DATABASE) == 33, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::ATTACH_DATABASE) == 34, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::DETACH_DATABASE) == 35, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::USE_DATABASE) == 36, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_SEQUENCE) == 37, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_TYPE) == 39, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXTENSION_CLAUSE) == 40, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_GRAPH) == 41, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::USE_GRAPH) == 42, "disagrees with the value in #[cxx::bridge]");
} // namespace common
} // namespace lbug
